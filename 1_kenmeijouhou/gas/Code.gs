/**
 * ============================================================
 * 件名情報 登録・管理システム v7 - 共有バックエンド（Google Apps Script）
 * ============================================================
 * Googleドライブ上のJSONファイル1つ（kenmei_data_v7.json）に
 * 件名データ・マスタ・管理者パスワードを保存し、複数人が同じ
 * データへ同時にアクセス・更新できるようにするためのAPIです。
 *
 * 【デプロイ方法】
 *   1. https://script.google.com/ で新規プロジェクトを作成
 *   2. このファイルの内容を「Code.gs」に貼り付け
 *   3. appsscript.json の内容をエディタの「プロジェクトの設定」→
 *      「マニフェストファイルを editor で表示する」を有効にした後、
 *      appsscript.json タブに貼り付け
 *   4. 「デプロイ」→「新しいデプロイ」→ 種類:「ウェブアプリ」
 *        - 実行するユーザー: 「自分」
 *        - アクセスできるユーザー: 「全員」
 *      でデプロイし、発行された「ウェブアプリURL」をコピー
 *   5. index.html の ④メンテナンス→「サーバー連携(GAS)」に
 *      そのURLを貼り付けて保存
 *
 * 詳しい手順は README_DEPLOY.md を参照してください。
 * ============================================================
 */

// 保存先ファイル名（Googleドライブのマイドライブ直下に作成されます）
var FILE_NAME = "kenmei_data_v7.json";

// データファイルの ID を記憶しておくスクリプトプロパティのキー。
// ※ Googleドライブは同名ファイルの重複作成を許可するため、名前検索（getFilesByName）だけに
//   頼ると、デプロイのやり直し等で同名ファイルが複数存在した場合に「どのファイルを返すか」が
//   不定になり、たまたま空のファイルを返してしまう＝実質的に「サーバー側データが消えた」ように
//   見える不具合の原因になる。そのため、一度特定したファイルのIDをスクリプトプロパティに固定
//   保存し、以後は常に同じファイルを参照するようにする。
var FILE_ID_PROP_KEY = "KENMEI_DATA_FILE_ID";

// 任意の共有シークレット（index.html側の設定と一致させることで簡易的な
// アクセス制限になります。空文字のままなら誰でもURLを知っていればアクセス可能）
var SHARED_SECRET = "";

// ------------------------------------------------------------
// データファイルの取得・作成
// ------------------------------------------------------------
function getOrCreateDataFile_() {
  var props = PropertiesService.getScriptProperties();
  var savedId = props.getProperty(FILE_ID_PROP_KEY);
  if (savedId) {
    try {
      var f = DriveApp.getFileById(savedId);
      // トラッシュに入っていないか確認（入っていれば無効なIDとして再取得を試みる）
      if (!f.isTrashed()) return f;
    } catch (e) {
      // 保存されていたIDが無効（削除済み等）の場合は下の検索処理にフォールバック
    }
  }
  // スクリプトプロパティに記録が無い（初回、または旧バージョンからの移行）場合は、
  // 名前で検索する。同名ファイルが複数見つかった場合、単純に「最初に見つかった1件」を
  // 使うと、それがたまたま空／少量データのファイルだった場合に「データが消えたように見える」
  // 不具合が再発しかねないため、内容をパースして cases 件数が最も多いファイルを正として選び、
  // そのIDをスクリプトプロパティに固定記録する（以後は毎回同じファイルを指す）。
  var files = DriveApp.getFilesByName(FILE_NAME);
  var best = null, bestCount = -1;
  while (files.hasNext()) {
    var cand = files.next();
    var cnt = -1;
    try {
      var obj = JSON.parse(cand.getBlob().getDataAsString("UTF-8"));
      cnt = Array.isArray(obj.cases) ? obj.cases.length : 0;
    } catch (e) {
      cnt = 0;
    }
    if (cnt > bestCount) { bestCount = cnt; best = cand; }
  }
  if (best) {
    props.setProperty(FILE_ID_PROP_KEY, best.getId());
    return best;
  }
  var initial = {
    cases: [],
    master: null,
    pw: null,
    deletedIds: {},
    masterDeletedIds: {},
    updatedAt: new Date().toISOString()
  };
  var created = DriveApp.createFile(FILE_NAME, JSON.stringify(initial), MimeType.PLAIN_TEXT);
  props.setProperty(FILE_ID_PROP_KEY, created.getId());
  return created;
}

function readData_() {
  var file = getOrCreateDataFile_();
  var text = file.getBlob().getDataAsString("UTF-8");
  try {
    var obj = JSON.parse(text);
    if (!Array.isArray(obj.cases)) obj.cases = [];
    if (!obj.deletedIds || typeof obj.deletedIds !== "object") obj.deletedIds = {};
    if (!obj.masterDeletedIds || typeof obj.masterDeletedIds !== "object") obj.masterDeletedIds = {};
    return obj;
  } catch (e) {
    return { cases: [], master: null, pw: null, deletedIds: {}, masterDeletedIds: {}, updatedAt: new Date().toISOString() };
  }
}

function writeData_(data) {
  var file = getOrCreateDataFile_();
  data.updatedAt = new Date().toISOString();
  file.setContent(JSON.stringify(data));
  return data;
}

// ------------------------------------------------------------
// マージ処理（updatedAtの新しい方を採用／削除は deletedIds で管理）
// 戻り値は { cases: [...], deletedIds: {...} } で、deletedIds は自己修復
// （下記コメント参照）を適用した後の削除記録。
// ------------------------------------------------------------
function mergeCases_(baseArr, incomingArr, deletedIds) {
  var baseMap = {};
  (baseArr || []).forEach(function (c) { if (c && c.id) baseMap[c.id] = c; });
  var incMap = {};
  (incomingArr || []).forEach(function (c) { if (c && c.id) incMap[c.id] = c; });

  var map = {};
  Object.keys(baseMap).forEach(function (id) { map[id] = baseMap[id]; });
  Object.keys(incMap).forEach(function (id) {
    var exist = map[id];
    if (!exist) { map[id] = incMap[id]; return; }
    var a = exist.updatedAt || "";
    var b = incMap[id].updatedAt || "";
    if (b >= a) map[id] = incMap[id];
  });

  // 削除済みIDは除外（削除後に更新された場合のみ復活を許可）。
  // ---- 自己修復：サーバー側・送信側の「両方」が、その件名IDを現存データとして
  // 持っている場合、それは「実際には削除されていない」という強い証拠である
  // （本当に削除されたなら、削除した側では既にデータが無いはず）。この場合は
  // 削除記録自体が誤り（過去の削除操作の記録が残ったまま、後からデータが復元
  // された等）と判断し、削除記録を無効化してデータを保持する。
  var healedDeletedIds = {};
  Object.keys(deletedIds || {}).forEach(function (id) { healedDeletedIds[id] = deletedIds[id]; });
  Object.keys(deletedIds || {}).forEach(function (id) {
    if (!map[id]) return;
    if (baseMap[id] && incMap[id]) {
      // 自己修復発動：削除記録を破棄し、データはそのまま残す
      delete healedDeletedIds[id];
      return;
    }
    var delAt = deletedIds[id] || "";
    var updAt = map[id].updatedAt || "";
    // 削除後に明確に新しい更新（updatedAtの日付部分が削除日より後）が
    // 無ければ削除状態を優先する。deletedIds側は日付のみ（YYYY-MM-DD）の精度のため、
    // updatedAt（日時形式に拡張後も）を先頭10文字（日付部分）に揃えて比較する
    // （updatedAtの時刻精度をここでの判定に混ぜないことで、従来と同じ「削除翌日以降の
    //  再登録のみ復活を許容する」挙動を維持する）。
    if (!(updAt && delAt && updAt.slice(0, 10) > delAt.slice(0, 10))) {
      delete map[id];
    }
  });
  return {
    cases: Object.keys(map).map(function (k) { return map[k]; }),
    deletedIds: healedDeletedIds
  };
}

// masterDeletedIds: { owners:{識別子:日付}, prob:{...}, status:{...}, forms:{...},
//   groups:{...}, pairs:{pet:日付}, formMap:{pet+"\u0000"+form:日付}, ownerGroups:{owner:日付} }
// 削除トゥームストーンに載っている項目は、統合（union/upsert）後に必ず除外する。
// ---- 自己修復（mergeCases_と同じ考え方）：base（サーバー側）・incoming（送信側）の
// 「両方」に、ある識別子の項目が現に存在している場合、それは「実際には削除されていない」
// という強い証拠であるため、その識別子の削除記録は自動的に無効化してデータを保持する。
// これにより、片方の端末に古い削除記録が残っていても、両者に存在する正常な項目が
// 誤って消去され続ける（＝サーバー側JSONから消えてしまう）ことを防ぐ。
// 戻り値は { master: {...}, masterDeletedIds: {...} }（自己修復後の削除記録も返す）。
function mergeMaster_(base, incoming, masterDeletedIds) {
  masterDeletedIds = masterDeletedIds || {};
  var result;
  if (!incoming && !base) {
    result = base;
  } else {
    result = JSON.parse(JSON.stringify(base || incoming));
    if (incoming && base) {
      ["owners", "prob", "status", "forms", "groups"].forEach(function (k) {
        var set = {};
        (result[k] || []).forEach(function (v) { set[v] = true; });
        (incoming[k] || []).forEach(function (v) { set[v] = true; });
        result[k] = Object.keys(set);
      });
      if (Array.isArray(incoming.pairs)) {
        var pmap = {};
        (result.pairs || []).forEach(function (p) { if (p && p.pet) pmap[p.pet] = p; });
        incoming.pairs.forEach(function (p) { if (p && p.pet) pmap[p.pet] = p; });
        result.pairs = Object.keys(pmap).map(function (k) { return pmap[k]; });
      }
      if (Array.isArray(incoming.formMap)) {
        var fmap = {};
        (result.formMap || []).forEach(function (p) { if (p && p.pet && p.form) fmap[p.pet + "\u0000" + p.form] = p; });
        incoming.formMap.forEach(function (p) { if (p && p.pet && p.form) fmap[p.pet + "\u0000" + p.form] = p; });
        result.formMap = Object.keys(fmap).map(function (k) { return fmap[k]; });
      }
      if (Array.isArray(incoming.ownerGroups)) {
        var omap = {};
        (result.ownerGroups || []).forEach(function (x) { if (x && x.owner) omap[x.owner] = x; });
        incoming.ownerGroups.forEach(function (x) { if (x && x.owner) omap[x.owner] = x; });
        result.ownerGroups = Object.keys(omap).map(function (k) { return omap[k]; });
      }
    }
  }
  if (!result) return { master: result, masterDeletedIds: masterDeletedIds };

  // 自己修復後の削除記録（無効化された識別子を除いたコピー）
  var healed = JSON.parse(JSON.stringify(masterDeletedIds));

  ["owners", "prob", "status", "forms", "groups"].forEach(function (k) {
    var del = masterDeletedIds[k];
    if (!del) return;
    var baseSet = {}; (base && Array.isArray(base[k]) ? base[k] : []).forEach(function (v) { baseSet[v] = true; });
    var incSet = {}; (incoming && Array.isArray(incoming[k]) ? incoming[k] : []).forEach(function (v) { incSet[v] = true; });
    Object.keys(del).forEach(function (v) {
      if (baseSet[v] && incSet[v]) { delete healed[k][v]; }
    });
    if (Array.isArray(result[k])) {
      var delNow = healed[k] || {};
      result[k] = result[k].filter(function (v) { return !Object.prototype.hasOwnProperty.call(delNow, v); });
    }
  });

  if (masterDeletedIds.pairs) {
    var baseP = {}; (base && Array.isArray(base.pairs) ? base.pairs : []).forEach(function (p) { if (p && p.pet) baseP[p.pet] = true; });
    var incP = {}; (incoming && Array.isArray(incoming.pairs) ? incoming.pairs : []).forEach(function (p) { if (p && p.pet) incP[p.pet] = true; });
    Object.keys(masterDeletedIds.pairs).forEach(function (pet) {
      if (baseP[pet] && incP[pet]) { delete healed.pairs[pet]; }
    });
    if (Array.isArray(result.pairs)) {
      var delPairsNow = healed.pairs || {};
      result.pairs = result.pairs.filter(function (p) {
        return !(p && p.pet && Object.prototype.hasOwnProperty.call(delPairsNow, p.pet));
      });
    }
  }

  if (masterDeletedIds.formMap) {
    var baseF = {}; (base && Array.isArray(base.formMap) ? base.formMap : []).forEach(function (p) { if (p && p.pet && p.form) baseF[p.pet + "\u0000" + p.form] = true; });
    var incF = {}; (incoming && Array.isArray(incoming.formMap) ? incoming.formMap : []).forEach(function (p) { if (p && p.pet && p.form) incF[p.pet + "\u0000" + p.form] = true; });
    Object.keys(masterDeletedIds.formMap).forEach(function (key) {
      if (baseF[key] && incF[key]) { delete healed.formMap[key]; }
    });
    if (Array.isArray(result.formMap)) {
      var delFormMapNow = healed.formMap || {};
      result.formMap = result.formMap.filter(function (p) {
        if (!p) return true;
        var key = (p.pet || "") + "\u0000" + (p.form || "");
        return !Object.prototype.hasOwnProperty.call(delFormMapNow, key);
      });
    }
  }

  if (masterDeletedIds.ownerGroups) {
    var baseO = {}; (base && Array.isArray(base.ownerGroups) ? base.ownerGroups : []).forEach(function (x) { if (x && x.owner) baseO[x.owner] = true; });
    var incO = {}; (incoming && Array.isArray(incoming.ownerGroups) ? incoming.ownerGroups : []).forEach(function (x) { if (x && x.owner) incO[x.owner] = true; });
    Object.keys(masterDeletedIds.ownerGroups).forEach(function (owner) {
      if (baseO[owner] && incO[owner]) { delete healed.ownerGroups[owner]; }
    });
    if (Array.isArray(result.ownerGroups)) {
      var delOwnerGroupsNow = healed.ownerGroups || {};
      result.ownerGroups = result.ownerGroups.filter(function (x) {
        return !(x && x.owner && Object.prototype.hasOwnProperty.call(delOwnerGroupsNow, x.owner));
      });
    }
  }

  return { master: result, masterDeletedIds: healed };
}

function mergeDeletedIds_(base, incoming) {
  var result = {};
  Object.keys(base || {}).forEach(function (id) { result[id] = base[id]; });
  Object.keys(incoming || {}).forEach(function (id) {
    if (!result[id] || incoming[id] > result[id]) result[id] = incoming[id];
  });
  return result;
}

// masterDeletedIds同士（フィールド名でネストしたマップ）のマージ。各フィールド内は日付の新しい方を採用。
function mergeMasterDeletedIds_(base, incoming) {
  var result = {};
  var keys = {};
  Object.keys(base || {}).forEach(function (k) { keys[k] = true; });
  Object.keys(incoming || {}).forEach(function (k) { keys[k] = true; });
  Object.keys(keys).forEach(function (k) {
    result[k] = mergeDeletedIds_((base && base[k]) || {}, (incoming && incoming[k]) || {});
  });
  return result;
}

// ------------------------------------------------------------
// レスポンス生成
// ------------------------------------------------------------
function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkSecret_(token) {
  if (!SHARED_SECRET) return true;
  return token === SHARED_SECRET;
}

// ------------------------------------------------------------
// GET: データ取得 ?action=load&token=xxx
// ------------------------------------------------------------
function doGet(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var params = (e && e.parameter) || {};
    if (!checkSecret_(params.token)) {
      return jsonOutput_({ ok: false, error: "invalid token" });
    }
    var action = params.action || "load";
    if (action === "load") {
      var data = readData_();
      return jsonOutput_({ ok: true, data: data });
    }
    return jsonOutput_({ ok: false, error: "unknown action: " + action });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------
// POST: 保存（マージ）
// body: { action:"save", token, cases:[...], master:{...}, pw, deletedIds:{...}, masterDeletedIds:{...} }
// ------------------------------------------------------------
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var body = {};
    try { body = JSON.parse(e.postData.contents); } catch (e2) { body = {}; }
    if (!checkSecret_(body.token)) {
      return jsonOutput_({ ok: false, error: "invalid token" });
    }
    var action = body.action || "save";
    if (action === "save") {
      var current = readData_();
      var mergedDeletedPre = mergeDeletedIds_(current.deletedIds, body.deletedIds || {});
      var caseMergeResult = mergeCases_(current.cases || [], body.cases || [], mergedDeletedPre);
      var mergedCases = caseMergeResult.cases;
      // 自己修復（サーバー・端末の両方が現存データとして持っているIDの削除記録を無効化）後の削除記録
      var mergedDeleted = caseMergeResult.deletedIds;
      // ★ プロトタイプ変更: ドロップダウン項目マスタ（MASTER）は、通常の「同期（save）」では
      //   一切変更しない（クライアントから送られてきた master は無視する）。
      //   理由: 一般ユーザーの同期は「サーバー側マスタが常に正」として扱いたいため、
      //   ユーザー端末の（古いかもしれない）マスタ内容がサーバーへ反映されては困る。
      //   マスタの更新は、管理者専用の action:"save_master"（このファイル内、別ブロック）
      //   でのみ行う。masterDeletedIds（削除トゥームストーン）もこの経路では更新しない。
      var mergedMaster = current.master;
      var mergedMasterDeleted = current.masterDeletedIds || {};

      // ---- 安全装置：統合後の件名件数が、サーバー側・送信内容のどちらよりも大幅に
      // 減っている場合は、原因不明の異常な減少とみなして書き込みを中止する。
      // （通常のマージでは件数は基本的に減らない＝和集合になるはずのため、大幅な減少は
      //   トゥームストーンの誤作動やファイル取得の不整合など、何らかの異常を意味する）
      var beforeCount = Math.max((current.cases || []).length, (body.cases || []).length);
      var afterCount = mergedCases.length;
      var DROP_RATIO_THRESHOLD = 0.5; // 50%以上減ったら異常とみなす
      var DROP_ABS_MIN = 3; // 件数が少ない場合の誤検知を避けるための最低減少件数
      if (beforeCount >= DROP_ABS_MIN && afterCount < beforeCount * (1 - DROP_RATIO_THRESHOLD)) {
        // 消えかけている件名の例を診断情報として返す（先頭5件まで）
        var mergedIdSet = {};
        mergedCases.forEach(function (c) { if (c && c.id) mergedIdSet[c.id] = true; });
        var missingExamples = [];
        (current.cases || []).concat(body.cases || []).forEach(function (c) {
          if (c && c.id && !mergedIdSet[c.id] && missingExamples.length < 5) {
            missingExamples.push((c.kenmeiNo || "(No.未設定)") + " / " + (c.kenmei || "(件名未設定)"));
          }
        });
        return jsonOutput_({
          ok: false,
          error: "abnormal_drop_blocked",
          message: "同期の結果、件名データが大幅に減少するため書き込みを中止しました。データは変更されていません。",
          diagnostics: {
            serverCountBefore: (current.cases || []).length,
            clientSentCount: (body.cases || []).length,
            mergedCountWouldBe: afterCount,
            missingExamples: missingExamples,
            healedDeletedIdCount: Object.keys(mergedDeletedPre || {}).length - Object.keys(mergedDeleted || {}).length
          }
        });
      }

      var result = {
        cases: mergedCases,
        master: mergedMaster,
        pw: (body.pw != null ? body.pw : current.pw),
        deletedIds: mergedDeleted,
        masterDeletedIds: mergedMasterDeleted
      };
      writeData_(result);
      return jsonOutput_({ ok: true, data: result });
    }
    // action === "overwrite": マージせず、クライアントから送られた内容でサーバー側データを完全に置き換える
    // （⑤メンテナンス「サーバーを全消去してローカルから取得（上書き同期）」機能専用）
    if (action === "overwrite") {
      var overwriteResult = {
        cases: body.cases || [],
        master: body.master || null,
        pw: (body.pw != null ? body.pw : null),
        deletedIds: body.deletedIds || {},
        masterDeletedIds: body.masterDeletedIds || {}
      };
      writeData_(overwriteResult);
      return jsonOutput_({ ok: true, data: overwriteResult });
    }
    // action === "save_master": ドロップダウン項目マスタ（MASTER）の管理者専用更新。
    // ⑤メンテナンス（パスワード認証済みの管理者画面）からのみ呼び出される想定。
    // 通常の action:"save" とは異なり、マージは一切行わず、送信された master で
    // サーバー側のマスタを完全に置き換える（= 管理者の編集内容がそのままサーバーの正となる）。
    // cases・deletedIds には一切触れない（件名データへの影響はゼロ）。
    if (action === "save_master") {
      var currentForMaster = readData_();
      var masterSaveResult = {
        cases: currentForMaster.cases || [],
        master: body.master || null,
        pw: currentForMaster.pw,
        deletedIds: currentForMaster.deletedIds || {},
        // マージ経路を使わないため、masterDeletedIds（マスタ削除トゥームストーン）は
        // この管理者専用更新に合わせて、送信された内容（通常は空でよい）でリセットする。
        masterDeletedIds: body.masterDeletedIds || {}
      };
      writeData_(masterSaveResult);
      return jsonOutput_({ ok: true, data: masterSaveResult });
    }
    return jsonOutput_({ ok: false, error: "unknown action: " + action });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
