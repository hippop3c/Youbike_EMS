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
var MAX_COMPLETED = 5000;

// 貼上低電量派工 Google 表單的 ID 後，手動執行一次 setupDispatchForm。
// 表單網址若為 https://docs.google.com/forms/d/ABC123/edit，ID 就是 ABC123。
var GOOGLE_FORM_ID = '';
var WORK_ORDER_FIELD = '工單編號（系統比對用）';
var COMPLETION_SPREADSHEET_ID = '1Se-0yDne1QuyR15--iBPm0oCZjnVahb-SI0LdJM9kPo';
var COMPLETION_SHEET_NAME = '維修完成紀錄';

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (String(p.wo || '') === '1') {
      return jsonOutput_(readJson_('workorders', []));
    }
    if (String(p.completed || '') === '1') {
      return jsonOutput_(readCompletedSheet_());
    }
    if (p.checkId) {
      var checkId = normalizeWorkOrderId_(p.checkId);
      var completed = readJson_('completed', []);
      return jsonOutput_({
        ok: true,
        id: checkId,
        completed: completed.some(function (x) { return x && x.id === checkId; })
      });
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
      var completedIds = completedIdMap_();
      var dispatchable = body.items.filter(function (item) {
        var id = normalizeWorkOrderId_(item && item.id);
        return id && !completedIds[id] && !isCompleted_(item) && isLowBatteryDisabled_(item);
      });
      writeJson_('workorders', dispatchable);
      return jsonOutput_({
        ok: true,
        count: dispatchable.length,
        skipped: body.items.length - dispatchable.length
      });
    }

    if (op === 'completeWO') {
      var workOrderId = normalizeWorkOrderId_(body.id);
      if (!workOrderId) throw new Error('缺少工單編號 id');
      var done = readJson_('completed', []);
      var existing = -1;
      for (var d = 0; d < done.length; d++) {
        if (done[d] && done[d].id === workOrderId) { existing = d; break; }
      }
      var completedRec = {
        id: workOrderId,
        completedAt: body.completedAt || new Date().toISOString(),
        employee: String(body.employee || ''),
        station: String(body.station || ''),
        zone: String(body.zone || ''),
        vehicleIds: Array.isArray(body.vehicleIds) ? body.vehicleIds : []
      };
      if (existing >= 0) done[existing] = completedRec;
      else done.push(completedRec);
      done = done.slice(-MAX_COMPLETED);
      writeJson_('completed', done);

      // 同步從待派清單移除，避免下一台裝置仍讀到舊工單。
      var pending = readJson_('workorders', []).filter(function (item) {
        return normalizeWorkOrderId_(item && item.id) !== workOrderId;
      });
      writeJson_('workorders', pending);
      return jsonOutput_({ ok: true, id: workOrderId, duplicate: existing >= 0 });
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

/**
 * 手動執行一次：在 Google 表單新增「工單編號（系統比對用）」欄位。
 * 若欄位已存在，不會重複新增。
 */
function setupDispatchForm() {
  if (!GOOGLE_FORM_ID) throw new Error('請先設定 GOOGLE_FORM_ID');
  var form = FormApp.openById(GOOGLE_FORM_ID);
  var items = form.getItems();
  for (var i = 0; i < items.length; i++) {
    if (items[i].getTitle() === WORK_ORDER_FIELD) {
      return { ok: true, created: false, message: '欄位已存在' };
    }
  }
  form.addTextItem()
    .setTitle(WORK_ORDER_FIELD)
    .setHelpText('請勿自行修改；系統使用此編號比對完成紀錄，避免重複派工。')
    .setRequired(true);
  return { ok: true, created: true, message: '欄位新增完成' };
}

function completedIdMap_() {
  var rows = readJson_('completed', []);
  var map = {};
  rows.forEach(function (row) {
    var id = normalizeWorkOrderId_(row && row.id);
    if (id) map[id] = true;
  });
  return map;
}

function normalizeWorkOrderId_(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 120);
}

function readCompletedSheet_() {
  var sheet = SpreadsheetApp.openById(COMPLETION_SPREADSHEET_ID).getSheetByName(COMPLETION_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getDisplayValues();
  var headers = values.shift();
  var stationIndex = headers.indexOf('場站代碼');
  var vehicleIndex = headers.indexOf('自行車號');
  var reasonIndex = headers.indexOf('維修原因');
  var completedIndex = headers.indexOf('完成時間');
  var recordIndex = headers.indexOf('紀錄ID');
  if (stationIndex < 0 || vehicleIndex < 0) throw new Error('維修完成紀錄缺少場站代碼或自行車號欄位');
  return values.filter(function (row) {
    return row[stationIndex] && row[vehicleIndex];
  }).map(function (row) {
    return {
      id: recordIndex >= 0 ? row[recordIndex] : '',
      stationCode: row[stationIndex],
      vehicleId: row[vehicleIndex],
      reason: reasonIndex >= 0 ? row[reasonIndex] : '',
      completedAt: completedIndex >= 0 ? row[completedIndex] : ''
    };
  });
}

function isLowBatteryDisabled_(item) {
  if (!item || typeof item !== 'object') return false;
  var reasons = [];
  if (item.reason) reasons.push(item.reason);
  if (item.issue) reasons.push(item.issue);
  if (Array.isArray(item.vehicles)) {
    item.vehicles.forEach(function (vehicle) {
      if (Array.isArray(vehicle)) reasons.push(vehicle[1]);
      else if (vehicle && typeof vehicle === 'object') reasons.push(vehicle.reason || vehicle.issue);
    });
  }
  return reasons.some(function (reason) {
    return String(reason || '').indexOf('低電量禁用') !== -1;
  });
}

function isCompleted_(item) {
  if (!item || typeof item !== 'object') return false;
  var value = item.completedNote || item.completionStatus || item.status || '';
  return String(value).trim() === '已完成';
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
