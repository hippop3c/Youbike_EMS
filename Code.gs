/**
 * 智慧維護調度 — 選用的 Google Apps Script 同步後端
 *
 * 部署為「網頁應用程式」後，將 /exec 網址貼到 index.html 的 SYNC_URL。
 * 這是輕量示範儲存層；公開部署時，任何知道網址的人都可能讀寫資料。
 */

var APP_PREFIX = 'maint_dispatch_v1:';
var CHUNK_SIZE = 6500; // Script Properties 單值限制內的安全大小（Base64 字元）
var MAX_ZONE_ACTS = 200;
var ACT_TTL_MS = 12 * 60 * 60 * 1000;

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (String(p.wo || '') === '1') {
      return jsonOutput_(readJson_('workorders', []));
    }
    var zone = safeKey_(p.zone || '');
    if (!zone) return jsonOutput_([]);
    return jsonOutput_(pruneActs_(readJson_('zone:' + zone, [])));
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var op = String(body.op || '');

    if (op === 'setWO') {
      if (!Array.isArray(body.items)) throw new Error('items 必須是陣列');
      writeJson_('workorders', body.items);
      return jsonOutput_({ ok: true, count: body.items.length });
    }

    var zone = safeKey_(body.zone || '');
    if (!zone) throw new Error('缺少 zone');
    var key = 'zone:' + zone;
    var acts = pruneActs_(readJson_(key, []));

    if (op === 'upsert') {
      var rec = body.rec;
      if (!rec || typeof rec !== 'object' || !rec.id) throw new Error('rec.id 為必填');
      var idx = -1;
      for (var i = 0; i < acts.length; i++) {
        if (acts[i] && acts[i].id === rec.id) { idx = i; break; }
      }
      if (idx >= 0) acts[idx] = rec;
      else acts.push(rec);
      acts = pruneActs_(acts);
      writeJson_(key, acts);
      return jsonOutput_(acts);
    }

    if (op === 'remove') {
      var id = String(body.id || '');
      acts = acts.filter(function (x) { return x && x.id !== id; });
      writeJson_(key, acts);
      return jsonOutput_(acts);
    }

    if (op === 'clearZone') {
      writeJson_(key, []);
      return jsonOutput_([]);
    }

    throw new Error('不支援的 op: ' + op);
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function pruneActs_(acts) {
  if (!Array.isArray(acts)) return [];
  var cut = Date.now() - ACT_TTL_MS;
  return acts.filter(function (x) {
    var ts = x && Number(x.doneTs || x.ts || 0);
    return ts >= cut;
  }).slice(-MAX_ZONE_ACTS);
}

function safeKey_(value) {
  var s = String(value || '').trim();
  return s ? encodeURIComponent(s).slice(0, 80) : '';
}

function writeJson_(name, value) {
  var props = PropertiesService.getScriptProperties();
  var key = APP_PREFIX + name;
  var raw = JSON.stringify(value);
  var encoded = Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8);
  var parts = [];
  for (var i = 0; i < encoded.length; i += CHUNK_SIZE) {
    parts.push(encoded.substring(i, i + CHUNK_SIZE));
  }

  var oldCount = Number(props.getProperty(key + ':count') || 0);
  var values = {};
  values[key + ':count'] = String(parts.length);
  for (var j = 0; j < parts.length; j++) values[key + ':' + j] = parts[j];
  props.setProperties(values, false);
  for (var k = parts.length; k < oldCount; k++) props.deleteProperty(key + ':' + k);
}

function readJson_(name, fallback) {
  var props = PropertiesService.getScriptProperties();
  var key = APP_PREFIX + name;
  var count = Number(props.getProperty(key + ':count') || 0);
  if (!count) return fallback;

  var chunks = [];
  for (var i = 0; i < count; i++) {
    var chunk = props.getProperty(key + ':' + i);
    if (chunk == null) return fallback;
    chunks.push(chunk);
  }

  try {
    var bytes = Utilities.base64DecodeWebSafe(chunks.join(''));
    var raw = Utilities.newBlob(bytes).getDataAsString('UTF-8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function jsonOutput_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
