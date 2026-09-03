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
var MAX_ASSIGNMENT_ITEMS = 5;
var APP_VERSION = 'v2';
var TAIPEI_TIME_ZONE = 'Asia/Taipei';
var SHEET_TIMESTAMP_FORMAT = 'yyyy-mm-dd hh:mm:ss.000';

// 貼上低電量派工 Google 表單的 ID 後，手動執行一次 setupDispatchForm。
// 表單網址若為 https://docs.google.com/forms/d/ABC123/edit，ID 就是 ABC123。
var GOOGLE_FORM_ID = '';
var WORK_ORDER_FIELD = '工單編號（系統比對用）';
var COMPLETION_SPREADSHEET_ID = '1Se-0yDne1QuyR15--iBPm0oCZjnVahb-SI0LdJM9kPo';
var COMPLETION_SHEET_NAME = '維修完成紀錄';
var UNDO_SHEET_NAME = '維修撤銷紀錄';
var DISPATCH_SHEET_NAME = '派工總表';
var SHIFT_DISPATCH_SHEETS = {
  '早': ['派工總表(早)', '早班派工總表', '早派工總表', '早班總表', '早班', '早', DISPATCH_SHEET_NAME],
  '晚': ['派工總表(晚)', '晚班派工總表', '晚派工總表', '晚班總表', '晚班', '晚'],
  '夜': ['派工總表(夜)', '夜班派工總表', '夜派工總表', '大夜班派工總表', '夜班總表', '夜班', '夜']
};
var SHIFT_WORK_ORDER_KEY = { '早': 'EARLY', '晚': 'LATE', '夜': 'NIGHT' };
var COMPLETION_HEADERS = [
  '紀錄ID', '完成時間', '寫入時間', '員工編號', '車號/車牌', '責任區',
  '回報方式', '場站代碼', '場站名稱', '自行車號', '車柱', '維修原因',
  '班別', '派工總表', '工單編號'
];
var UNDO_HEADERS = COMPLETION_HEADERS.concat(['撤銷時間', '撤銷ID', '撤銷人員']);

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (String(p.health || '') === '1') {
      return jsonOutput_({ ok: true, version: APP_VERSION, shifts: ['早', '晚', '夜'] });
    }
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
    return jsonOutput_({
      ok: false,
      error: String(err && err.message || err),
      retryable: Boolean(err && err.retryable) || isTransientServiceError_(err)
    });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    try { lock.waitLock(30000); }
    catch (lockError) { throw retryableError_('同步忙碌，稍後自動重試'); }
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var op = String(body.op || '');
    if (op === 'completeWO' || op === 'completeShiftWO' || op === 'undoShiftWO') ensureTaipeiTimestampMigration_();

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

    if (op === 'completeWO' || op === 'completeShiftWO') {
      var workOrderId = normalizeWorkOrderId_(body.id);
      if (!workOrderId) throw new Error('缺少工單編號 id');
      var shift = normalizeShift_(body.shift);
      var stationCode = String(body.stationCode || '').trim();
      var completionRecordId = String(body.recordId || '').trim().slice(0, 200);
      if (!stationCode) throw new Error('缺少場站代碼');
      if (op === 'completeShiftWO') {
        if (!shift || !String(body.dispatchSheet || '').trim()) throw new Error('班別或派工總表不完整');
        if (!String(body.employee || '').trim() || !completionRecordId) throw new Error('員工或完成事件編號不完整');
        if (workOrderId !== shiftWorkOrderId_(shift, stationCode)) throw new Error('工單編號與班別或場站不符');
      } else {
        // 舊版 completeWO 僅允許原本的無班別派工總表，避免誤寫晚班或夜班。
        if (body.shift || body.dispatchSheet) throw new Error('舊版完成操作不可指定班別或派工總表');
        if (workOrderId !== legacyWorkOrderId_(stationCode)) throw new Error('舊版工單編號與場站不符');
        shift = '';
      }
      body.shift = shift;
      var completedAt = taipeiIsoTimestamp_(body.completedAt || new Date());
      var vehicleItems = normalizeCompletionVehicles_(body.vehicles);
      if (!vehicleItems.length) throw new Error('缺少已完成車輛資料');
      if (vehicleItems.length > MAX_ASSIGNMENT_ITEMS) throw new Error('一次最多完成五筆派工');

      // 完成紀錄保留同仁及作業資訊；派工總表則直接寫入「已完成」。
      // 先找出待更新的派工列，避免只留下完成紀錄卻沒有工單註記。
      var dispatchUpdate = prepareDispatchCompletion_(body, vehicleItems);
      body.dispatchSheet = dispatchUpdate.sheetName;
      assertCompletionEventNotUndone_(body, completionRecordId || workOrderId, vehicleItems);
      var completionWrite = null;
      var dispatchRowsUpdated = 0;
      try {
        completionWrite = appendCompletionRecords_(body, workOrderId, completedAt, vehicleItems);
        if (completionWrite.confirmed !== vehicleItems.length) throw new Error('完成紀錄寫入筆數不完整');
        dispatchRowsUpdated = writeDispatchCompletion_(dispatchUpdate);
        if (dispatchRowsUpdated < vehicleItems.length - dispatchUpdate.completedMissingCount) {
          throw new Error('派工總表完成註記寫入筆數不完整');
        }
      } catch (completionError) {
        if (completionError && completionError.terminal) throw completionError;
        // 任一步驟失敗就回復這次新增的完成列及原本的總表註記，避免半套同步。
        try {
          rollbackCompletionAppend_(completionWrite);
          restoreDispatchCompletion_(dispatchUpdate);
          SpreadsheetApp.flush();
        } catch (rollbackError) {
          throw retryableError_('完成同步失敗且自動回復失敗：' + rollbackError.message);
        }
        throw retryableError_('完成同步未寫入，將自動重試：' + completionError.message);
      }
      try { rebuildCompletedCache_(); } catch (cacheError) { Logger.log('重建完成快取失敗：' + cacheError); }

      // 同步從待派清單移除，避免下一台裝置仍讀到舊工單。
      try {
        var pending = readJson_('workorders', []).filter(function (item) {
          return normalizeWorkOrderId_(item && item.id) !== workOrderId;
        });
        writeJson_('workorders', pending);
      } catch (pendingError) { Logger.log('更新待派快取失敗：' + pendingError); }
      return jsonOutput_({
        ok: true,
        id: workOrderId,
        duplicate: completionWrite.inserted === 0,
        completedRows: completionWrite.confirmed,
        ownedVehicleIds: completionWrite.ownedVehicleIds,
        alreadyCompletedVehicleIds: completionWrite.alreadyCompletedVehicleIds,
        dispatchRowsUpdated: dispatchRowsUpdated,
        dispatchSheet: dispatchUpdate.sheetName
      });
    }

    if (op === 'undoShiftWO') {
      var undoWorkOrderId = normalizeWorkOrderId_(body.id);
      var undoShift = normalizeShift_(body.shift);
      var undoId = String(body.undoId || '').trim().slice(0, 200);
      var undoTargets = normalizeUndoTargets_(body.targets);
      var undoStationCode = String(body.stationCode || '').trim();
      if (!undoWorkOrderId || !undoShift || !undoId || !undoStationCode || !undoTargets.length ||
          !String(body.dispatchSheet || '').trim() || !String(body.employee || '').trim()) throw new Error('撤銷資料不完整');
      if (!Array.isArray(body.targets) || undoTargets.length !== body.targets.length) throw new Error('撤銷目標重複或格式錯誤');
      if (undoTargets.length > MAX_ASSIGNMENT_ITEMS) throw new Error('一次最多撤銷五筆派工');
      var canonicalUndoId = shiftWorkOrderId_(undoShift, undoStationCode);
      var legacyUndoIdAllowed = undoShift === '早' && String(body.dispatchSheet || '').trim() === DISPATCH_SHEET_NAME &&
        undoWorkOrderId === legacyWorkOrderId_(undoStationCode);
      if (undoWorkOrderId !== canonicalUndoId && !legacyUndoIdAllowed) throw new Error('撤銷工單編號與班別或場站不符');
      body.shift = undoShift;
      body.id = undoWorkOrderId;

      var undoVehicles = undoTargets.map(function (target) { return { id: target.vehicleId }; });
      var undoDispatch = prepareDispatchCompletion_(body, undoVehicles);
      body.dispatchSheet = undoDispatch.sheetName;
      var spreadsheet = openCompletionSpreadsheet_();
      var completionUndo = prepareCompletionUndo_(spreadsheet, body, undoTargets, undoId);
      var completionUndoWrite = null;
      var dispatchRowsReopened = 0;
      try {
        // 非公式儲存格直接清除；公式儲存格保留公式並由完成紀錄移除後自動重算。
        clearDispatchCompletion_(undoDispatch);
        completionUndoWrite = archiveAndRemoveCompletionRows_(spreadsheet, completionUndo, body, undoId);
        SpreadsheetApp.flush();
        dispatchRowsReopened = verifyDispatchReopened_(undoDispatch);
        if (dispatchRowsReopened < undoVehicles.length - undoDispatch.completedMissingCount) {
          throw new Error('派工總表仍有完成註記，請檢查公式');
        }
      } catch (undoError) {
        // 還原失敗時把完成紀錄、撤銷稽核及總表註記全部回復到操作前狀態。
        try {
          rollbackCompletionUndo_(completionUndoWrite);
          restoreDispatchCompletion_(undoDispatch);
          SpreadsheetApp.flush();
        } catch (rollbackError) {
          throw retryableError_('撤銷同步失敗且自動回復失敗：' + rollbackError.message);
        }
        throw retryableError_('撤銷同步未完成，將自動重試：' + undoError.message);
      }
      try { rebuildCompletedCache_(); } catch (cacheError) { Logger.log('重建完成快取失敗：' + cacheError); }

      return jsonOutput_({
        ok: true,
        id: undoWorkOrderId,
        undoId: completionUndo.recordedUndoIds.length === 1 ? completionUndo.recordedUndoIds[0] : undoId,
        alreadyUndone: completionUndo.alreadyUndone,
        completionRowsRemoved: completionUndo.matches.length,
        dispatchRowsReopened: dispatchRowsReopened,
        dispatchSheet: undoDispatch.sheetName
      });
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
    return jsonOutput_({
      ok: false,
      error: String(err && err.message || err),
      retryable: Boolean(err && err.retryable) || isTransientServiceError_(err)
    });
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

function normalizeShift_(value) {
  var shift = String(value || '').trim();
  if (shift === '早' || shift === '早班') return '早';
  if (shift === '晚' || shift === '晚班') return '晚';
  if (shift === '夜' || shift === '夜班' || shift === '大夜班') return '夜';
  return '';
}

function shiftWorkOrderId_(shiftValue, stationCodeValue) {
  var shift = normalizeShift_(shiftValue);
  var stationCode = String(stationCodeValue || '').trim();
  if (!shift || !stationCode) return '';
  return normalizeWorkOrderId_('LOWBAT-' + SHIFT_WORK_ORDER_KEY[shift] + '-' + stationCode);
}

function legacyWorkOrderId_(stationCodeValue) {
  var stationCode = String(stationCodeValue || '').trim();
  return stationCode ? normalizeWorkOrderId_('LOWBAT-' + stationCode) : '';
}

function normalizeCompletionVehicles_(values) {
  if (!Array.isArray(values)) return [];
  var seen = {};
  return values.map(function (vehicle) {
    var id = String(vehicle && vehicle.id || '').trim();
    if (!id || seen[id]) return null;
    seen[id] = true;
    return {
      id: id,
      reason: String(vehicle && vehicle.reason || ''),
      dock: String(vehicle && vehicle.dock || ''),
      source: String(vehicle && vehicle.source || ''),
      battery: String(vehicle && vehicle.battery || '')
    };
  }).filter(function (vehicle) { return vehicle !== null; });
}

function normalizeUndoTargets_(values) {
  if (!Array.isArray(values)) return [];
  var seen = {};
  return values.map(function (target) {
    return {
      vehicleId: String(target && target.vehicleId || '').trim(),
      completionRecordId: String(target && target.completionRecordId || '').trim().slice(0, 200)
    };
  }).filter(function (target) {
    if (!target.vehicleId || !target.completionRecordId || seen[target.vehicleId]) return false;
    seen[target.vehicleId] = true;
    return true;
  });
}

function assertCompletionEventNotUndone_(body, recordId, vehicles) {
  var spreadsheet = SpreadsheetApp.openById(COMPLETION_SPREADSHEET_ID);
  var auditMap = readUndoAuditMap_(spreadsheet);
  var shift = normalizeShift_(body.shift);
  if (!shift && body.dispatchSheet === DISPATCH_SHEET_NAME) shift = '早';
  vehicles.forEach(function (vehicle) {
    var key = completionAuditKey_(shift, body.dispatchSheet, body.stationCode, recordId, vehicle.id);
    if (auditMap[key]) throw new Error('此完成事件已撤銷，不能重複使用相同事件編號');
  });
}

function appendCompletionRecords_(body, workOrderId, completedAt, vehicles) {
  var spreadsheet = openCompletionSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(COMPLETION_SHEET_NAME);
  if (!sheet) throw new Error('找不到維修完成紀錄工作表');
  var headerInfo = ensureCompletionHeaders_(sheet);

  var lastColumn = Math.max(sheet.getLastColumn(), headerInfo.values.length);
  var index = {};
  headerInfo.values.forEach(function (name, i) { index[String(name).trim()] = i; });
  var completionRecordId = String(body.recordId || workOrderId).trim().slice(0, 200);
  var targetStationCode = String(body.stationCode || '').trim();
  var targetShift = normalizeShift_(body.shift);
  var targetDispatchSheet = String(body.dispatchSheet || '').trim();
  var legacyWrite = !targetShift && targetDispatchSheet === DISPATCH_SHEET_NAME;
  var effectiveTargetShift = targetShift || (targetDispatchSheet === DISPATCH_SHEET_NAME ? '早' : '');
  var targetEmployee = String(body.employee || '').trim();
  var targetVehicleIds = {};
  vehicles.forEach(function (vehicle) {
    targetVehicleIds[String(vehicle && vehicle.id || '').trim()] = true;
  });
  var existingKeys = {};
  var alreadyCompletedKeys = {};
  var ownedVehicleIds = [];
  var alreadyCompletedVehicleIds = [];
  var existingRowCount = Math.max(0, sheet.getLastRow() - headerInfo.row);
  if (existingRowCount) {
    var existingValues = sheet.getRange(
      headerInfo.row + 1, 1, existingRowCount, Math.max(sheet.getLastColumn(), headerInfo.values.length)
    ).getDisplayValues();
    existingValues.forEach(function (existingRow) {
      var existingId = String(existingRow[index['紀錄ID']] || '').trim();
      var existingStation = String(existingRow[index['場站代碼']] || '').trim();
      var existingVehicle = String(existingRow[index['自行車號']] || '').trim();
      var existingShift = normalizeShift_(existingRow[index['班別']]);
      var existingDispatchSheet = String(existingRow[index['派工總表']] || '').trim();
      var existingWorkOrder = normalizeWorkOrderId_(existingRow[index['工單編號']]);
      var existingEmployee = String(existingRow[index['員工編號']] || '').trim();
      var effectiveExistingShift = existingShift;
      var effectiveExistingSheet = existingDispatchSheet;
      if (!existingShift && (!existingDispatchSheet || existingDispatchSheet === DISPATCH_SHEET_NAME)) {
        effectiveExistingShift = '早';
        effectiveExistingSheet = DISPATCH_SHEET_NAME;
      }
      var sameScope = existingStation === targetStationCode && targetVehicleIds[existingVehicle] &&
        effectiveExistingShift === effectiveTargetShift && effectiveExistingSheet === targetDispatchSheet;
      if (!sameScope) return;
      var exactNew = !legacyWrite && existingId === completionRecordId && existingShift === targetShift &&
        existingDispatchSheet === targetDispatchSheet && existingWorkOrder === workOrderId && existingEmployee === targetEmployee;
      var exactLegacy = legacyWrite && !existingShift && (!existingDispatchSheet || existingDispatchSheet === DISPATCH_SHEET_NAME) &&
        (existingId === completionRecordId || existingId === workOrderId) && (!existingWorkOrder || existingWorkOrder === workOrderId) &&
        existingEmployee === targetEmployee;
      if (exactNew || exactLegacy) {
        existingKeys[existingStation + '|' + existingVehicle] = true;
        if (ownedVehicleIds.indexOf(existingVehicle) < 0) ownedVehicleIds.push(existingVehicle);
      } else {
        // 同一車可能剛被另一位人員先完成；視為已達成，讓同批其餘車輛繼續寫入。
        alreadyCompletedKeys[existingStation + '|' + existingVehicle] = true;
        if (alreadyCompletedVehicleIds.indexOf(existingVehicle) < 0) alreadyCompletedVehicleIds.push(existingVehicle);
      }
    });
  }
  var completedDate = validDate_(completedAt);
  var writtenDate = new Date();
  var pendingVehicles = vehicles.filter(function (vehicle) {
    var key = targetStationCode + '|' + String(vehicle && vehicle.id || '').trim();
    return !existingKeys[key] && !alreadyCompletedKeys[key];
  });
  pendingVehicles.forEach(function (vehicle) {
    if (ownedVehicleIds.indexOf(vehicle.id) < 0) ownedVehicleIds.push(vehicle.id);
  });
  var rows = pendingVehicles.map(function (vehicle) {
    var row = Array(lastColumn).fill('');
    setByHeader_(row, index, '紀錄ID', completionRecordId);
    setByHeader_(row, index, '完成時間', completedDate);
    setByHeader_(row, index, '寫入時間', writtenDate);
    setByHeader_(row, index, '員工編號', String(body.employee || ''));
    setByHeader_(row, index, '車號/車牌', String(body.vehicle || ''));
    setByHeader_(row, index, '責任區', String(body.zone || ''));
    setByHeader_(row, index, '回報方式', '前台完成');
    setByHeader_(row, index, '場站代碼', String(body.stationCode || ''));
    setByHeader_(row, index, '場站名稱', String(body.station || ''));
    setByHeader_(row, index, '自行車號', String(vehicle && vehicle.id || ''));
    setByHeader_(row, index, '維修原因', String(vehicle && vehicle.reason || '低電量禁用'));
    setByHeader_(row, index, '班別', String(body.shift || ''));
    setByHeader_(row, index, '派工總表', String(body.dispatchSheet || ''));
    setByHeader_(row, index, '工單編號', workOrderId);
    return row;
  });
  var writeInfo = { sheet: sheet, startRow: 0, rowCount: 0, columnCount: lastColumn };
  if (rows.length) {
    var startRow = sheet.getLastRow() + 1;
    writeInfo.startRow = startRow;
    writeInfo.rowCount = rows.length;
    try {
      sheet.getRange(startRow, 1, rows.length, lastColumn).setValues(rows);
      formatTimestampColumns_(sheet, index, startRow, rows.length);
      SpreadsheetApp.flush();
    } catch (writeError) {
      try { rollbackCompletionAppend_(writeInfo); } catch (_) {}
      throw writeError;
    }
  }
  writeInfo.confirmed = vehicles.length;
  writeInfo.inserted = rows.length;
  writeInfo.alreadyCompleted = Object.keys(alreadyCompletedKeys).length;
  writeInfo.ownedVehicleIds = ownedVehicleIds;
  writeInfo.alreadyCompletedVehicleIds = alreadyCompletedVehicleIds;
  return writeInfo;
}

function rollbackCompletionAppend_(writeInfo) {
  if (!writeInfo || !writeInfo.sheet || !writeInfo.startRow || !writeInfo.rowCount) return;
  writeInfo.sheet.getRange(
    writeInfo.startRow, 1, writeInfo.rowCount, writeInfo.columnCount
  ).clearContent();
  writeInfo.rowCount = 0;
}

function validDate_(value) {
  var date = value instanceof Date ? value : new Date(String(value || ''));
  return isNaN(date.getTime()) ? new Date() : date;
}

function taipeiIsoTimestamp_(value) {
  return Utilities.formatDate(validDate_(value), TAIPEI_TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss.SSS") + '+08:00';
}

function openCompletionSpreadsheet_() {
  var spreadsheet = SpreadsheetApp.openById(COMPLETION_SPREADSHEET_ID);
  if (spreadsheet.getSpreadsheetTimeZone() !== TAIPEI_TIME_ZONE) {
    spreadsheet.setSpreadsheetTimeZone(TAIPEI_TIME_ZONE);
  }
  return spreadsheet;
}

function formatTimestampColumns_(sheet, index, startRow, rowCount) {
  ['完成時間', '寫入時間'].forEach(function (header) {
    if (Object.prototype.hasOwnProperty.call(index, header)) {
      sheet.getRange(startRow, index[header] + 1, rowCount, 1).setNumberFormat(SHEET_TIMESTAMP_FORMAT);
    }
  });
}

/** 手動執行一次：把既有 UTC ISO 字串轉為台北時區的試算表日期欄位。 */
function migrateCompletionTimestampsToTaipei() {
  var spreadsheet = openCompletionSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(COMPLETION_SHEET_NAME);
  if (!sheet) throw new Error('找不到維修完成紀錄工作表');
  var headerInfo = ensureCompletionHeaders_(sheet);
  var index = {};
  headerInfo.values.forEach(function (name, i) { index[String(name).trim()] = i; });
  var firstDataRow = headerInfo.row + 1;
  var rowCount = Math.max(0, sheet.getLastRow() - headerInfo.row);
  if (!rowCount) return 0;
  var converted = 0;
  ['完成時間', '寫入時間'].forEach(function (header) {
    if (!Object.prototype.hasOwnProperty.call(index, header)) return;
    var range = sheet.getRange(firstDataRow, index[header] + 1, rowCount, 1);
    var values = range.getValues();
    var formulas = range.getFormulas();
    values.forEach(function (row, rowIndex) {
      if (formulas[rowIndex][0] || !row[0] || row[0] instanceof Date) return;
      var parsed = new Date(String(row[0]));
      if (!isNaN(parsed.getTime())) {
        range.getCell(rowIndex + 1, 1).setValue(parsed);
        converted++;
      }
    });
    range.setNumberFormat(SHEET_TIMESTAMP_FORMAT);
  });
  SpreadsheetApp.flush();
  return converted;
}

function ensureTaipeiTimestampMigration_() {
  var props = PropertiesService.getScriptProperties();
  var key = APP_PREFIX + 'taipei_timestamp_migration_v1';
  if (props.getProperty(key) === 'done') return;
  migrateCompletionTimestampsToTaipei();
  props.setProperty(key, 'done');
}

function ensureCompletionHeaders_(sheet) {
  var required = ['紀錄ID', '完成時間', '員工編號', '場站代碼', '自行車號'];
  var existing = findHeaderRow_(sheet, required);
  if (existing) {
    var missing = COMPLETION_HEADERS.filter(function (header) {
      return existing.values.indexOf(header) < 0;
    });
    if (missing.length) {
      sheet.getRange(existing.row, existing.values.length + 1, 1, missing.length).setValues([missing]);
      existing.values = existing.values.concat(missing);
    }
    return existing;
  }

  // 既有分頁完全空白時，直接建立標準完成紀錄表頭。
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, COMPLETION_HEADERS.length).setValues([COMPLETION_HEADERS]);
    return { row: 1, values: COMPLETION_HEADERS.slice() };
  }
  throw new Error('維修完成紀錄缺少必要欄位');
}

function completedVehicleMapForScope_(shiftValue, dispatchSheetValue, stationCodeValue, vehicleIds) {
  var spreadsheet = openCompletionSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(COMPLETION_SHEET_NAME);
  if (!sheet) throw new Error('找不到維修完成紀錄工作表');
  var headerInfo = ensureCompletionHeaders_(sheet);
  var index = {};
  headerInfo.values.forEach(function (name, i) { index[String(name).trim()] = i; });
  var rowCount = Math.max(0, sheet.getLastRow() - headerInfo.row);
  if (!rowCount) return {};
  var targetShift = normalizeShift_(shiftValue);
  var targetSheet = String(dispatchSheetValue || '').trim();
  if (!targetShift && targetSheet === DISPATCH_SHEET_NAME) targetShift = '早';
  var targetStation = String(stationCodeValue || '').trim();
  var wanted = {};
  (vehicleIds || []).forEach(function (vehicleId) { wanted[String(vehicleId || '').trim()] = true; });
  var found = {};
  var values = sheet.getRange(
    headerInfo.row + 1, 1, rowCount, Math.max(sheet.getLastColumn(), headerInfo.values.length)
  ).getDisplayValues();
  values.forEach(function (row) {
    var vehicleId = String(row[index['自行車號']] || '').trim();
    if (!wanted[vehicleId] || String(row[index['場站代碼']] || '').trim() !== targetStation) return;
    var rowShift = normalizeShift_(row[index['班別']]);
    var rowSheet = String(row[index['派工總表']] || '').trim();
    if (!rowShift && (!rowSheet || rowSheet === DISPATCH_SHEET_NAME)) {
      rowShift = '早';
      rowSheet = DISPATCH_SHEET_NAME;
    }
    if (rowShift === targetShift && rowSheet === targetSheet) found[vehicleId] = true;
  });
  return found;
}

function prepareDispatchCompletion_(body, vehicles) {
  var spreadsheet = SpreadsheetApp.openById(COMPLETION_SPREADSHEET_ID);
  var sheet = resolveDispatchSheet_(spreadsheet, body.shift, body.dispatchSheet);
  var headerInfo = findHeaderRow_(sheet, ['車號', '鎖車場站', '完成註記']);
  if (!headerInfo) throw new Error(sheet.getName() + ' 缺少車號、鎖車場站或完成註記欄位');

  var vehicleIndex = headerInfo.values.indexOf('車號');
  var stationIndex = headerInfo.values.indexOf('鎖車場站');
  var noteIndex = headerInfo.values.indexOf('完成註記');
  var firstRow = headerInfo.row + 1;
  var rowCount = Math.max(0, sheet.getLastRow() - headerInfo.row);

  var values = rowCount
    ? sheet.getRange(firstRow, 1, rowCount, sheet.getLastColumn()).getDisplayValues()
    : [];
  var targetVehicles = {};
  vehicles.forEach(function (vehicle) { targetVehicles[String(vehicle && vehicle.id || '').trim()] = true; });
  var foundVehicles = {};
  var targetCode = String(body.stationCode || '').trim();
  var matchedRows = [];
  values.forEach(function (row, index) {
    var vehicle = String(row[vehicleIndex] || '').trim();
    var station = String(row[stationIndex] || '').trim();
    var stationCode = (station.match(/^\d{9}/) || [''])[0];
    if (targetVehicles[vehicle] && (!targetCode || stationCode === targetCode)) {
      matchedRows.push(index);
      foundVehicles[vehicle] = (foundVehicles[vehicle] || 0) + 1;
    }
  });
  var missingVehicles = Object.keys(targetVehicles).filter(function (vehicle) { return !foundVehicles[vehicle]; });
  var completedMissing = missingVehicles.length
    ? completedVehicleMapForScope_(body.shift, sheet.getName(), body.stationCode, missingVehicles)
    : {};
  var unresolvedMissing = missingVehicles.filter(function (vehicle) { return !completedMissing[vehicle]; });
  if (unresolvedMissing.length) throw new Error(sheet.getName() + ' 找不到相符車輛：' + unresolvedMissing.join('、'));
  var duplicateVehicles = Object.keys(foundVehicles).filter(function (vehicle) { return foundVehicles[vehicle] !== 1; });
  if (duplicateVehicles.length) throw new Error(sheet.getName() + ' 有重複車輛列，無法安全更新：' + duplicateVehicles.join('、'));

  var notesRange = rowCount ? sheet.getRange(firstRow, noteIndex + 1, rowCount, 1) : null;
  var originalNoteFormulas = notesRange ? notesRange.getFormulas() : [];
  var headerNoteFormula = String(sheet.getRange(headerInfo.row, noteIndex + 1).getFormula() || '');
  var arrayFormulaBased = [headerNoteFormula].concat(originalNoteFormulas.map(function (row) {
    return String(row[0] || '');
  })).some(function (formula) { return /ARRAYFORMULA\s*\(/i.test(formula); });
  return {
    sheet: sheet,
    sheetName: sheet.getName(),
    notesRange: notesRange,
    matchedRows: matchedRows,
    originalNoteValues: notesRange ? notesRange.getValues() : [],
    originalNoteFormulas: originalNoteFormulas,
    arrayFormulaBased: arrayFormulaBased,
    completedMissingCount: Object.keys(completedMissing).length
  };
}

function resolveDispatchSheet_(spreadsheet, shiftValue, requestedNameValue) {
  var shift = normalizeShift_(shiftValue);
  var requestedName = String(requestedNameValue || '').trim();

  // 舊版離線佇列沒有班別與分頁名稱，只允許回寫原本的派工總表。
  if (!shift && !requestedName) {
    var legacySheet = spreadsheet.getSheetByName(DISPATCH_SHEET_NAME);
    if (!legacySheet) throw new Error('找不到派工總表工作表');
    return legacySheet;
  }
  if (!shift) throw new Error('缺少班別');

  var candidates = SHIFT_DISPATCH_SHEETS[shift] || [];
  if (requestedName) {
    if (candidates.indexOf(requestedName) < 0) throw new Error('派工總表與班別不符');
    var requestedSheet = spreadsheet.getSheetByName(requestedName);
    if (!requestedSheet) throw new Error('找不到 ' + requestedName + ' 工作表');
    return requestedSheet;
  }

  for (var i = 0; i < candidates.length; i++) {
    var sheet = spreadsheet.getSheetByName(candidates[i]);
    if (sheet) return sheet;
  }
  throw new Error('找不到' + shift + '班派工總表工作表');
}

function writeDispatchCompletion_(update) {
  if (!update.notesRange) return 0;
  var formulas = update.originalNoteFormulas || update.notesRange.getFormulas();
  if (!update.arrayFormulaBased) {
    update.matchedRows.forEach(function (rowIndex) {
      // 單列公式保留並由完成紀錄重算；只有一般儲存格直接寫入。
      if (!String(formulas[rowIndex] && formulas[rowIndex][0] || '')) {
        update.notesRange.getCell(rowIndex + 1, 1).setValue('已完成');
      }
    });
  }
  SpreadsheetApp.flush();
  var writtenNotes = update.notesRange.getDisplayValues();
  return update.matchedRows.filter(function (rowIndex) {
    return String(writtenNotes[rowIndex][0] || '').trim() === '已完成';
  }).length;
}

function restoreDispatchCompletion_(update) {
  if (!update || !update.notesRange || !update.matchedRows) return;
  // ARRAYFORMULA 的展開格不能直接寫值；公式模式未直接改總表，也不需要回填。
  if (update.arrayFormulaBased) return;
  var values = update.originalNoteValues || [];
  var formulas = update.originalNoteFormulas || [];
  update.matchedRows.forEach(function (rowIndex) {
    var cell = update.notesRange.getCell(rowIndex + 1, 1);
    var formula = formulas[rowIndex] && String(formulas[rowIndex][0] || '');
    if (formula) cell.setFormula(formula);
    else cell.setValue(values[rowIndex] ? values[rowIndex][0] : '');
  });
}

function completionAuditKey_(shift, dispatchSheet, stationCode, recordId, vehicleId) {
  return JSON.stringify([
    normalizeShift_(shift), String(dispatchSheet || '').trim(), String(stationCode || '').trim(),
    String(recordId || '').trim(), String(vehicleId || '').trim()
  ]);
}

function prepareCompletionUndo_(spreadsheet, body, targets, undoId) {
  var sheet = spreadsheet.getSheetByName(COMPLETION_SHEET_NAME);
  if (!sheet) throw new Error('找不到維修完成紀錄工作表');
  var headerInfo = ensureCompletionHeaders_(sheet);
  var index = {};
  headerInfo.values.forEach(function (name, i) { index[String(name).trim()] = i; });
  var firstRow = headerInfo.row + 1;
  var rowCount = Math.max(0, sheet.getLastRow() - headerInfo.row);
  var columnCount = Math.max(sheet.getLastColumn(), headerInfo.values.length);
  var range = rowCount ? sheet.getRange(firstRow, 1, rowCount, columnCount) : null;
  var displayValues = range ? range.getDisplayValues() : [];
  var rawValues = range ? range.getValues() : [];
  var formulaValues = range ? range.getFormulas() : [];
  var targetStation = String(body.stationCode || '').trim();
  var targetEmployee = String(body.employee || '').trim();
  var activeByVehicle = {};

  displayValues.forEach(function (row, rowIndex) {
    var vehicleId = String(row[index['自行車號']] || '').trim();
    if (!vehicleId || !targets.some(function (target) { return target.vehicleId === vehicleId; })) return;
    var stationCode = String(row[index['場站代碼']] || '').trim();
    var rowShift = normalizeShift_(row[index['班別']]);
    var rowDispatchSheet = String(row[index['派工總表']] || '').trim();
    var legacyScope = !rowShift && (!rowDispatchSheet || rowDispatchSheet === DISPATCH_SHEET_NAME) &&
      body.shift === '早' && body.dispatchSheet === DISPATCH_SHEET_NAME;
    var exactScope = rowShift === body.shift && rowDispatchSheet === body.dispatchSheet;
    if (stationCode !== targetStation || (!legacyScope && !exactScope)) return;
    if (!activeByVehicle[vehicleId]) activeByVehicle[vehicleId] = [];
    activeByVehicle[vehicleId].push({
        sheetRow: firstRow + rowIndex,
        rawRow: rawValues[rowIndex],
        formulaRow: formulaValues[rowIndex],
      recordId: String(row[index['紀錄ID']] || '').trim(),
      employee: String(row[index['員工編號']] || '').trim(),
      workOrderId: normalizeWorkOrderId_(row[index['工單編號']]),
      legacy: legacyScope
    });
  });

  var auditMap = readUndoAuditMap_(spreadsheet);
  var matches = [];
  var alreadyUndoneCount = 0;
  var recordedUndoIds = {};
  targets.forEach(function (target) {
    var auditKey = completionAuditKey_(body.shift, body.dispatchSheet, targetStation, target.completionRecordId, target.vehicleId);
    var active = activeByVehicle[target.vehicleId] || [];
    var targetRows = active.filter(function (row) {
      var workOrderMatches = row.legacy
        ? (!row.workOrderId || row.workOrderId === body.id || row.workOrderId === legacyWorkOrderId_(targetStation))
        : row.workOrderId === body.id;
      return row.recordId === target.completionRecordId && row.employee === targetEmployee && workOrderMatches;
    });
    if (targetRows.length > 1) throw new Error('完成紀錄重複，無法安全撤銷');
    if (targetRows.length === 1) {
      if (active.length !== 1) throw new Error('同一車輛另有有效完成紀錄，不能直接重開');
      if (auditMap[auditKey]) recordedUndoIds[auditMap[auditKey]] = true;
      matches.push({
        sheetRow: targetRows[0].sheetRow,
        rawRow: targetRows[0].rawRow,
        formulaRow: targetRows[0].formulaRow,
        auditKey: auditKey
      });
      return;
    }
    if (active.length) throw new Error('完成紀錄與操作者或工單不符');
    if (auditMap[auditKey]) {
      recordedUndoIds[auditMap[auditKey]] = true;
      alreadyUndoneCount++;
      return;
    }
    throw new Error('找不到可撤銷的完成紀錄');
  });
  return {
    sheet: sheet,
    headerInfo: headerInfo,
    columnCount: columnCount,
    matches: matches,
    recordedUndoIds: Object.keys(recordedUndoIds),
    alreadyUndone: alreadyUndoneCount === targets.length
  };
}

function ensureUndoSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(UNDO_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(UNDO_SHEET_NAME);
  var headerInfo = findHeaderRow_(sheet, ['紀錄ID', '自行車號', '撤銷ID']);
  if (!headerInfo && (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0)) {
    sheet.getRange(1, 1, 1, UNDO_HEADERS.length).setValues([UNDO_HEADERS]);
    return { sheet: sheet, headerInfo: { row: 1, values: UNDO_HEADERS.slice() } };
  }
  if (!headerInfo) throw new Error('維修撤銷紀錄缺少必要欄位');
  var missing = UNDO_HEADERS.filter(function (header) { return headerInfo.values.indexOf(header) < 0; });
  if (missing.length) {
    sheet.getRange(headerInfo.row, headerInfo.values.length + 1, 1, missing.length).setValues([missing]);
    headerInfo.values = headerInfo.values.concat(missing);
  }
  return { sheet: sheet, headerInfo: headerInfo };
}

function readUndoAuditMap_(spreadsheet) {
  var map = {};
  var undoSheetInfo = ensureUndoSheet_(spreadsheet);
  var sheet = undoSheetInfo.sheet;
  var headerInfo = undoSheetInfo.headerInfo;
  if (sheet.getLastRow() <= headerInfo.row) return map;
  var index = {};
  headerInfo.values.forEach(function (name, i) { index[String(name).trim()] = i; });
  var rowCount = sheet.getLastRow() - headerInfo.row;
  var values = sheet.getRange(headerInfo.row + 1, 1, rowCount, sheet.getLastColumn()).getDisplayValues();
  values.forEach(function (row) {
    var key = completionAuditKey_(
      row[index['班別']], row[index['派工總表']], row[index['場站代碼']],
      row[index['紀錄ID']], row[index['自行車號']]
    );
    map[key] = String(row[index['撤銷ID']] || '').trim();
  });
  return map;
}

function archiveAndRemoveCompletionRows_(spreadsheet, undo, body, undoId) {
  if (!undo.matches.length) return {
    completionSheet: undo.sheet,
    completionColumnCount: undo.columnCount,
    matches: [],
    undoSheet: null,
    undoStartRow: 0,
    undoRowCount: 0,
    undoColumnCount: 0
  };
  var undoSheetInfo = ensureUndoSheet_(spreadsheet);
  var undoIndex = {};
  undoSheetInfo.headerInfo.values.forEach(function (name, i) { undoIndex[String(name).trim()] = i; });
  var completionIndex = {};
  undo.headerInfo.values.forEach(function (name, i) { completionIndex[String(name).trim()] = i; });
  var existingAudit = readUndoAuditMap_(spreadsheet);
  var archivedAt = new Date();
  var rows = undo.matches.filter(function (match) { return !existingAudit[match.auditKey]; }).map(function (match) {
    var row = Array(undoSheetInfo.headerInfo.values.length).fill('');
    COMPLETION_HEADERS.forEach(function (header) {
      if (Object.prototype.hasOwnProperty.call(completionIndex, header)) {
        setByHeader_(row, undoIndex, header, match.rawRow[completionIndex[header]]);
      }
    });
    setByHeader_(row, undoIndex, '班別', String(body.shift || ''));
    setByHeader_(row, undoIndex, '派工總表', String(body.dispatchSheet || ''));
    setByHeader_(row, undoIndex, '工單編號', String(body.id || ''));
    setByHeader_(row, undoIndex, '撤銷時間', archivedAt);
    setByHeader_(row, undoIndex, '撤銷ID', undoId);
    setByHeader_(row, undoIndex, '撤銷人員', String(body.employee || ''));
    return row;
  });
  var writeInfo = {
    completionSheet: undo.sheet,
    completionColumnCount: undo.columnCount,
    matches: undo.matches,
    undoSheet: undoSheetInfo.sheet,
    undoStartRow: 0,
    undoRowCount: 0,
    undoColumnCount: undoSheetInfo.headerInfo.values.length
  };
  try {
    if (rows.length) {
      var startRow = undoSheetInfo.sheet.getLastRow() + 1;
      writeInfo.undoStartRow = startRow;
      writeInfo.undoRowCount = rows.length;
      undoSheetInfo.sheet.getRange(startRow, 1, rows.length, undoSheetInfo.headerInfo.values.length).setValues(rows);
      undoSheetInfo.sheet.getRange(startRow, undoIndex['撤銷時間'] + 1, rows.length, 1).setNumberFormat(SHEET_TIMESTAMP_FORMAT);
      SpreadsheetApp.flush();
    }
    // 保留列位置、清空內容；公式會視為完成紀錄不存在，失敗時也能精確回填。
    undo.matches.forEach(function (match) {
      undo.sheet.getRange(match.sheetRow, 1, 1, undo.columnCount).clearContent();
    });
    SpreadsheetApp.flush();
    return writeInfo;
  } catch (writeError) {
    try { rollbackCompletionUndo_(writeInfo); } catch (_) {}
    throw writeError;
  }
}

function rollbackCompletionUndo_(writeInfo) {
  if (!writeInfo) return;
  if (writeInfo.completionSheet && writeInfo.matches) {
    writeInfo.matches.forEach(function (match) {
      var row = (match.rawRow || []).slice(0, writeInfo.completionColumnCount);
      while (row.length < writeInfo.completionColumnCount) row.push('');
      writeInfo.completionSheet.getRange(
        match.sheetRow, 1, 1, writeInfo.completionColumnCount
      ).setValues([row]);
      (match.formulaRow || []).forEach(function (formula, columnIndex) {
        if (formula) writeInfo.completionSheet.getRange(match.sheetRow, columnIndex + 1).setFormula(formula);
      });
    });
  }
  if (writeInfo.undoSheet && writeInfo.undoStartRow && writeInfo.undoRowCount) {
    writeInfo.undoSheet.getRange(
      writeInfo.undoStartRow, 1, writeInfo.undoRowCount, writeInfo.undoColumnCount
    ).clearContent();
    writeInfo.undoRowCount = 0;
  }
}

function clearDispatchCompletion_(update) {
  if (!update.notesRange) return;
  // 公式欄只移除完成紀錄，讓 ARRAYFORMULA 自行重算，不能動到展開格。
  if (update.arrayFormulaBased) return;
  var notes = update.notesRange.getDisplayValues();
  update.matchedRows.forEach(function (rowIndex) {
    if (String(update.originalNoteFormulas[rowIndex] && update.originalNoteFormulas[rowIndex][0] || '')) return;
    var value = String(notes[rowIndex][0] || '').trim();
    if (value && value !== '已完成') throw new Error('完成註記不是可撤銷狀態');
  });
  update.matchedRows.forEach(function (rowIndex) {
    if (!String(update.originalNoteFormulas[rowIndex] && update.originalNoteFormulas[rowIndex][0] || '')) {
      update.notesRange.getCell(rowIndex + 1, 1).clearContent();
    }
  });
  SpreadsheetApp.flush();
}

function verifyDispatchReopened_(update) {
  if (!update.notesRange) return 0;
  var notes = update.notesRange.getDisplayValues();
  return update.matchedRows.filter(function (rowIndex) {
    return String(notes[rowIndex][0] || '').trim() === '';
  }).length;
}

function rebuildCompletedCache_() {
  var spreadsheet = openCompletionSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(COMPLETION_SHEET_NAME);
  if (!sheet) throw new Error('找不到維修完成紀錄工作表');
  var headerInfo = ensureCompletionHeaders_(sheet);
  var index = {};
  headerInfo.values.forEach(function (name, i) { index[String(name).trim()] = i; });
  var rowCount = Math.max(0, sheet.getLastRow() - headerInfo.row);
  var values = rowCount
    ? sheet.getRange(headerInfo.row + 1, 1, rowCount, Math.max(sheet.getLastColumn(), headerInfo.values.length)).getDisplayValues()
    : [];
  var grouped = {};
  var order = [];
  values.forEach(function (row) {
    var stationCode = String(row[index['場站代碼']] || '').trim();
    var vehicleId = String(row[index['自行車號']] || '').trim();
    if (!stationCode || !vehicleId) return;
    var shift = normalizeShift_(row[index['班別']]);
    var workOrderId = normalizeWorkOrderId_(row[index['工單編號']]);
    if (!workOrderId && shift) workOrderId = shiftWorkOrderId_(shift, stationCode);
    if (!workOrderId) workOrderId = normalizeWorkOrderId_(row[index['紀錄ID']]);
    if (!workOrderId) return;
    if (!grouped[workOrderId]) {
      grouped[workOrderId] = {
        id: workOrderId,
        completedAt: String(row[index['完成時間']] || ''),
        employee: String(row[index['員工編號']] || ''),
        station: String(row[index['場站名稱']] || ''),
        stationCode: stationCode,
        zone: String(row[index['責任區']] || ''),
        shift: shift,
        dispatchSheet: String(row[index['派工總表']] || ''),
        vehicleIds: []
      };
      order.push(workOrderId);
    }
    if (grouped[workOrderId].vehicleIds.indexOf(vehicleId) < 0) grouped[workOrderId].vehicleIds.push(vehicleId);
  });
  var completed = order.map(function (id) { return grouped[id]; }).slice(-MAX_COMPLETED);
  writeJson_('completed', completed);
  return completed;
}

function findHeaderRow_(sheet, requiredHeaders) {
  if (sheet.getLastColumn() < 1) return null;
  var scanRows = Math.min(10, Math.max(1, sheet.getLastRow()));
  var values = sheet.getRange(1, 1, scanRows, sheet.getLastColumn()).getDisplayValues();
  for (var i = 0; i < values.length; i++) {
    var names = values[i].map(function (x) { return String(x).trim(); });
    var allFound = requiredHeaders.every(function (name) { return names.indexOf(name) >= 0; });
    if (allFound) return { row: i + 1, values: names };
  }
  return null;
}

function setByHeader_(row, index, header, value) {
  if (Object.prototype.hasOwnProperty.call(index, header)) row[index[header]] = value;
}

function readCompletedSheet_() {
  var sheet = SpreadsheetApp.openById(COMPLETION_SPREADSHEET_ID).getSheetByName(COMPLETION_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 1) return [];
  var headerInfo = findHeaderRow_(sheet, ['場站代碼', '自行車號']);
  if (!headerInfo) throw new Error('維修完成紀錄缺少表頭');
  var rowCount = Math.max(0, sheet.getLastRow() - headerInfo.row);
  if (!rowCount) return [];
  var headers = headerInfo.values;
  var values = sheet.getRange(
    headerInfo.row + 1, 1, rowCount, Math.max(sheet.getLastColumn(), headers.length)
  ).getDisplayValues();
  var stationIndex = headers.indexOf('場站代碼');
  var vehicleIndex = headers.indexOf('自行車號');
  var reasonIndex = headers.indexOf('維修原因');
  var completedIndex = headers.indexOf('完成時間');
  var recordIndex = headers.indexOf('紀錄ID');
  var employeeIndex = headers.indexOf('員工編號');
  var truckIndex = headers.indexOf('車號/車牌');
  var zoneIndex = headers.indexOf('責任區');
  var wayIndex = headers.indexOf('回報方式');
  var stationNameIndex = headers.indexOf('場站名稱');
  var dockIndex = headers.indexOf('車柱');
  var shiftIndex = headers.indexOf('班別');
  var dispatchSheetIndex = headers.indexOf('派工總表');
  var workOrderIndex = headers.indexOf('工單編號');
  if (stationIndex < 0 || vehicleIndex < 0) throw new Error('維修完成紀錄缺少場站代碼或自行車號欄位');
  return values.filter(function (row) {
    return row[stationIndex] && row[vehicleIndex];
  }).map(function (row) {
    return {
      id: recordIndex >= 0 ? row[recordIndex] : '',
      stationCode: row[stationIndex],
      vehicleId: row[vehicleIndex],
      reason: reasonIndex >= 0 ? row[reasonIndex] : '',
      completedAt: completedIndex >= 0 ? row[completedIndex] : '',
      employee: employeeIndex >= 0 ? row[employeeIndex] : '',
      vehicle: truckIndex >= 0 ? row[truckIndex] : '',
      zone: zoneIndex >= 0 ? row[zoneIndex] : '',
      way: wayIndex >= 0 ? row[wayIndex] : '',
      station: stationNameIndex >= 0 ? row[stationNameIndex] : '',
      dock: dockIndex >= 0 ? row[dockIndex] : '',
      shift: shiftIndex >= 0 ? row[shiftIndex] : '',
      dispatchSheet: dispatchSheetIndex >= 0 ? row[dispatchSheetIndex] : '',
      workOrderId: workOrderIndex >= 0 ? row[workOrderIndex] : ''
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

function retryableError_(message) {
  var error = new Error(String(message || '暫時性同步錯誤'));
  error.retryable = true;
  return error;
}

function terminalError_(message) {
  var error = new Error(String(message || '無法完成操作'));
  error.terminal = true;
  return error;
}

function isTransientServiceError_(error) {
  return /service invoked too many times|service spreadsheets failed|internal error|server error|please wait a bit|try again|currently unavailable|service unavailable|timed? ?out|temporar|exceeded maximum execution time|稍後再試|暫時/i
    .test(String(error && error.message || error || ''));
}
