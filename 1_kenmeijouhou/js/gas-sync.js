/* ================================================================
 * GAS（Google Apps Script）サーバー連携モジュール
 * 複数人で同一データ（Googleドライブ上のJSON）を共有・同期するための
 * クライアント側処理。index.html のメイン処理より後に読み込まれる前提で、
 * MASTER / CASES / saveMaster() / saveCases() / getPassword() / setPassword() /
 * esc() / nk() / MASTER_INIT / buildFilters() / renderList() / renderMgCases() /
 * renderMg() などのグローバル関数・変数をそのまま利用する。
 * ================================================================ */
(function(){
  "use strict";

  var GAS_URL_KEY      = "kenmei_gas_url_v7";
  var GAS_TOKEN_KEY    = "kenmei_gas_token_v7";
  var GAS_AUTOSYNC_KEY = "kenmei_gas_autosync_v7";
  var DELETED_KEY       = "kenmei_deleted_v7";
  var LAST_SYNC_KEY     = "kenmei_gas_lastsync_v7";

  // ---------------- 削除トゥームストーン（同期時に他端末の古いデータで復活しないようにする） ----------------
  var DELETED_IDS = loadDeleted();
  function loadDeleted(){
    try{ return JSON.parse(localStorage.getItem(DELETED_KEY) || "{}"); }catch(e){ return {}; }
  }
  function saveDeleted(){ localStorage.setItem(DELETED_KEY, JSON.stringify(DELETED_IDS)); }
  function todayStr(){ var d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
  window.markDeleted = function(id){
    if(!id) return;
    DELETED_IDS[id] = todayStr();
    saveDeleted();
  };
  window.markDeletedAll = function(arr){
    var d = todayStr();
    (arr||[]).forEach(function(c){ if(c && c.id) DELETED_IDS[c.id] = d; });
    saveDeleted();
  };

  // ---------------- マスタ（ドロップダウン項目）削除トゥームストーン ----------------
  // MASTER_DELETED_IDS の形: { owners:{識別子:日付}, prob:{...}, status:{...}, forms:{...},
  //   groups:{...}, pairs:{ペットネーム:日付}, formMap:{ペットネーム\u0000形式:日付}, ownerGroups:{担当者名:日付} }
  var MASTER_DELETED_KEY = "kenmei_master_deleted_v7";
  var MASTER_DELETED_IDS = loadMasterDeleted();
  function loadMasterDeleted(){
    try{ return JSON.parse(localStorage.getItem(MASTER_DELETED_KEY) || "{}"); }catch(e){ return {}; }
  }
  function saveMasterDeleted(){ localStorage.setItem(MASTER_DELETED_KEY, JSON.stringify(MASTER_DELETED_IDS)); }
  // 削除操作の直前に呼ぶ: key はMASTERのプロパティ名（owners/prob/status/forms/groups/pairs/formMap/ownerGroups）、
  // identity はその項目を一意に識別する文字列（文字列配列ならその値そのもの、pairsならpet、formMapならpet+"\u0000"+form、ownerGroupsならowner名）
  window.markMasterDeleted = function(key, identity){
    if(!key || identity===undefined || identity===null || identity==="") return;
    if(!MASTER_DELETED_IDS[key]) MASTER_DELETED_IDS[key] = {};
    MASTER_DELETED_IDS[key][identity] = todayStr();
    saveMasterDeleted();
  };
  // 同じ識別子を編集・再追加した場合は「削除の取り消し」とみなしてトゥームストーンを解除する
  window.clearMasterDeleted = function(key, identity){
    if(!key || identity===undefined || identity===null || identity==="") return;
    if(MASTER_DELETED_IDS[key] && Object.prototype.hasOwnProperty.call(MASTER_DELETED_IDS[key], identity)){
      delete MASTER_DELETED_IDS[key][identity];
      saveMasterDeleted();
    }
  };
  // 「初期値に戻す」等の一括復元操作用: すべてのマスタ削除トゥームストーンを消去する
  window.clearAllMasterDeleted = function(){
    MASTER_DELETED_IDS = {};
    saveMasterDeleted();
  };

  // ---------------- 設定の読み書き ----------------
  function gasConfig(){
    return {
      url:   localStorage.getItem(GAS_URL_KEY) || "",
      token: localStorage.getItem(GAS_TOKEN_KEY) || "",
      auto:  localStorage.getItem(GAS_AUTOSYNC_KEY) === "1"
    };
  }
  function gasSetConfig(url, token, auto){
    // ★ ブラウザのプライバシー設定（プライベートブラウジング／サードパーティストレージ
    //   ブロック等）によりlocalStorageへの書き込みが拒否される環境があるため、例外を
    //   捕捉してtrue/falseで呼び出し元へ結果を返す（無言で失敗して保存メッセージだけ
    //   「保存しました」と表示されてしまう不具合を防ぐ）。
    try{
      localStorage.setItem(GAS_URL_KEY, url || "");
      localStorage.setItem(GAS_TOKEN_KEY, token || "");
      localStorage.setItem(GAS_AUTOSYNC_KEY, auto ? "1" : "0");
      return true;
    }catch(e){
      return false;
    }
  }

  // ---------------- クライアント側マージ（サーバーpush前の安全なpull用） ----------------
  // 戻り値は { cases:[...], deletedIds:{...} }（自己修復後の削除記録も返す）。
  function mergeCasesClient(baseArr, incomingArr, deletedIds){
    var baseMap = {};
    (baseArr || []).forEach(function(c){ if(c && c.id) baseMap[c.id] = c; });
    var incMap = {};
    (incomingArr || []).forEach(function(c){ if(c && c.id) incMap[c.id] = c; });

    var map = {};
    Object.keys(baseMap).forEach(function(id){ map[id] = baseMap[id]; });
    Object.keys(incMap).forEach(function(id){
      var exist = map[id];
      if(!exist){ map[id] = incMap[id]; return; }
      var a = exist.updatedAt || "", b = incMap[id].updatedAt || "";
      if(b >= a) map[id] = incMap[id];
    });

    // 自己修復：ローカル・サーバーの両方がそのIDを現存データとして持っている場合、
    // 削除記録は誤り（過去の削除操作の記録が残ったまま、後からデータが復元された等）と
    // みなして無効化し、データを保持する（gas/Code.gs 側の mergeCases_ と同じ考え方）。
    var healedDeletedIds = {};
    Object.keys(deletedIds || {}).forEach(function(id){ healedDeletedIds[id] = deletedIds[id]; });
    Object.keys(deletedIds || {}).forEach(function(id){
      if(!map[id]) return;
      if(baseMap[id] && incMap[id]){
        delete healedDeletedIds[id];
        return;
      }
      var delAt = deletedIds[id] || "";
      var updAt = map[id].updatedAt || "";
      // deletedIds側は日付のみ（YYYY-MM-DD）の精度のため、updatedAt（日時形式）は
      // 先頭10文字（日付部分）に揃えて比較する（gas/Code.gs側のmergeCases_と同じ考え方）。
      if(!(updAt && delAt && updAt.slice(0,10) > delAt.slice(0,10))) delete map[id];
    });
    return {
      cases: Object.keys(map).map(function(k){ return map[k]; }),
      deletedIds: healedDeletedIds
    };
  }
  // masterDeletedIds: { owners:{識別子:日付}, prob:{...}, ... } 形式。削除済み項目は
  // 統合（union/upsert）後に必ず除外することで、他端末の古いコピーによる「復活」を防ぐ。
  // ---- 自己修復（gas/Code.gs の mergeMaster_ と同じ考え方）：base（ローカル）・incoming
  // （サーバー）の「両方」に、ある識別子の項目が現に存在している場合、それは「実際には
  // 削除されていない」という強い証拠であるため、その識別子の削除記録は自動的に無効化して
  // データを保持する。片方の端末に古い削除記録が残っていても、両者に存在する正常な項目が
  // 誤って消去され続けることを防ぐ。
  // 戻り値は { master:{...}, masterDeletedIds:{...} }（自己修復後の削除記録も返す）。
  function mergeMasterClient(base, incoming, masterDeletedIds){
    masterDeletedIds = masterDeletedIds || {};
    if(!incoming && !base) return { master: base, masterDeletedIds: masterDeletedIds };
    var result = JSON.parse(JSON.stringify(base || incoming));
    if(incoming && base){
      ["owners","prob","status","forms","groups"].forEach(function(k){
        var set = {};
        (result[k]||[]).forEach(function(v){ set[v]=true; });
        (incoming[k]||[]).forEach(function(v){ set[v]=true; });
        result[k] = Object.keys(set);
      });
      if(Array.isArray(incoming.pairs)){
        var pmap = {};
        (result.pairs||[]).forEach(function(p){ if(p && p.pet) pmap[p.pet]=p; });
        incoming.pairs.forEach(function(p){ if(p && p.pet) pmap[p.pet]=p; });
        result.pairs = Object.keys(pmap).map(function(k){ return pmap[k]; });
      }
      if(Array.isArray(incoming.formMap)){
        var fmap = {};
        (result.formMap||[]).forEach(function(p){ if(p&&p.pet&&p.form) fmap[p.pet+"\u0000"+p.form]=p; });
        incoming.formMap.forEach(function(p){ if(p&&p.pet&&p.form) fmap[p.pet+"\u0000"+p.form]=p; });
        result.formMap = Object.keys(fmap).map(function(k){ return fmap[k]; });
      }
      if(Array.isArray(incoming.ownerGroups)){
        var omap = {};
        (result.ownerGroups||[]).forEach(function(x){ if(x&&x.owner) omap[x.owner]=x; });
        incoming.ownerGroups.forEach(function(x){ if(x&&x.owner) omap[x.owner]=x; });
        result.ownerGroups = Object.keys(omap).map(function(k){ return omap[k]; });
      }
    }

    var healed = JSON.parse(JSON.stringify(masterDeletedIds));

    // トゥームストーン適用（自己修復付き）：削除済みとして記録されている項目を除外する
    ["owners","prob","status","forms","groups"].forEach(function(k){
      var del = masterDeletedIds[k];
      if(!del) return;
      var baseSet = {}; (base && Array.isArray(base[k]) ? base[k] : []).forEach(function(v){ baseSet[v]=true; });
      var incSet = {}; (incoming && Array.isArray(incoming[k]) ? incoming[k] : []).forEach(function(v){ incSet[v]=true; });
      Object.keys(del).forEach(function(v){
        if(baseSet[v] && incSet[v]){ delete healed[k][v]; }
      });
      if(Array.isArray(result[k])){
        var delNow = healed[k] || {};
        result[k] = result[k].filter(function(v){ return !Object.prototype.hasOwnProperty.call(delNow, v); });
      }
    });
    if(masterDeletedIds.pairs){
      var baseP = {}; (base && Array.isArray(base.pairs) ? base.pairs : []).forEach(function(p){ if(p && p.pet) baseP[p.pet]=true; });
      var incP = {}; (incoming && Array.isArray(incoming.pairs) ? incoming.pairs : []).forEach(function(p){ if(p && p.pet) incP[p.pet]=true; });
      Object.keys(masterDeletedIds.pairs).forEach(function(pet){
        if(baseP[pet] && incP[pet]){ delete healed.pairs[pet]; }
      });
      if(Array.isArray(result.pairs)){
        var delPairsNow = healed.pairs || {};
        result.pairs = result.pairs.filter(function(p){
          return !(p && p.pet && Object.prototype.hasOwnProperty.call(delPairsNow, p.pet));
        });
      }
    }
    if(masterDeletedIds.formMap){
      var baseF = {}; (base && Array.isArray(base.formMap) ? base.formMap : []).forEach(function(p){ if(p&&p.pet&&p.form) baseF[p.pet+"\u0000"+p.form]=true; });
      var incF = {}; (incoming && Array.isArray(incoming.formMap) ? incoming.formMap : []).forEach(function(p){ if(p&&p.pet&&p.form) incF[p.pet+"\u0000"+p.form]=true; });
      Object.keys(masterDeletedIds.formMap).forEach(function(key){
        if(baseF[key] && incF[key]){ delete healed.formMap[key]; }
      });
      if(Array.isArray(result.formMap)){
        var delFormMapNow = healed.formMap || {};
        result.formMap = result.formMap.filter(function(p){
          if(!p) return true;
          var key = (p.pet||"") + "\u0000" + (p.form||"");
          return !Object.prototype.hasOwnProperty.call(delFormMapNow, key);
        });
      }
    }
    if(masterDeletedIds.ownerGroups){
      var baseO = {}; (base && Array.isArray(base.ownerGroups) ? base.ownerGroups : []).forEach(function(x){ if(x&&x.owner) baseO[x.owner]=true; });
      var incO = {}; (incoming && Array.isArray(incoming.ownerGroups) ? incoming.ownerGroups : []).forEach(function(x){ if(x&&x.owner) incO[x.owner]=true; });
      Object.keys(masterDeletedIds.ownerGroups).forEach(function(owner){
        if(baseO[owner] && incO[owner]){ delete healed.ownerGroups[owner]; }
      });
      if(Array.isArray(result.ownerGroups)){
        var delOwnerGroupsNow = healed.ownerGroups || {};
        result.ownerGroups = result.ownerGroups.filter(function(x){
          return !(x && x.owner && Object.prototype.hasOwnProperty.call(delOwnerGroupsNow, x.owner));
        });
      }
    }
    return { master: result, masterDeletedIds: healed };
  }
  function mergeDeletedIdsClient(base, incoming){
    var result = {};
    Object.keys(base||{}).forEach(function(id){ result[id]=base[id]; });
    Object.keys(incoming||{}).forEach(function(id){
      if(!result[id] || incoming[id] > result[id]) result[id] = incoming[id];
    });
    return result;
  }
  // masterDeletedIds同士（フィールド名でネストしたマップ）のマージ。各フィールド内は日付の新しい方を採用。
  function mergeMasterDeletedIdsClient(base, incoming){
    var result = {};
    var keys = {};
    Object.keys(base||{}).forEach(function(k){ keys[k]=true; });
    Object.keys(incoming||{}).forEach(function(k){ keys[k]=true; });
    Object.keys(keys).forEach(function(k){
      result[k] = mergeDeletedIdsClient((base&&base[k])||{}, (incoming&&incoming[k])||{});
    });
    return result;
  }

  // ---------------- UI 更新 （ページ内の複数のパッド・フォームを同方向でコピーするため、
  // class / data-属性で全个を対象にする ----------------
  function setMsg(text, kind){
    document.querySelectorAll('[data-gas-role="msg"]').forEach(function(el){
      el.className = "gas-msg" + (kind ? " " + kind : "");
      el.textContent = text;
    });
  }
  function setLastSync(){
    var t = new Date().toLocaleString("ja-JP");
    localStorage.setItem(LAST_SYNC_KEY, t);
    document.querySelectorAll('[data-gas-role="lastsync"]').forEach(function(el){
      el.textContent = "最終同期: " + t;
    });
  }
  function refreshLastSyncLabel(){
    var t = localStorage.getItem(LAST_SYNC_KEY);
    document.querySelectorAll('[data-gas-role="lastsync"]').forEach(function(el){
      el.textContent = t ? ("最終同期: " + t) : "最終同期: まだ実行していません";
    });
  }

  var _suppressPush = false;
  function afterServerAdopt(mergedCases, mergedMaster, mergedPw, mergedDeleted, mergedMasterDeleted){
    _suppressPush = true;
    if(Array.isArray(mergedCases)) CASES = mergedCases;
    if(mergedMaster){
      // 旧バージョン互換の補完（loadMaster()と同じ考え方）
      if(!Array.isArray(mergedMaster.formMap)) mergedMaster.formMap = JSON.parse(JSON.stringify(MASTER_INIT.formMap));
      if(!Array.isArray(mergedMaster.forms))   mergedMaster.forms   = [].concat(MASTER_INIT.forms||[]);
      if(!Array.isArray(mergedMaster.pairs))   mergedMaster.pairs   = JSON.parse(JSON.stringify(MASTER_INIT.pairs));
      if(!Array.isArray(mergedMaster.groups))  mergedMaster.groups  = [].concat(MASTER_INIT.groups||[]);
      if(!Array.isArray(mergedMaster.ownerGroups)) mergedMaster.ownerGroups = JSON.parse(JSON.stringify(MASTER_INIT.ownerGroups));
      if(!Array.isArray(mergedMaster.prob)) mergedMaster.prob=[].concat(MASTER_INIT.prob||[]);
      if(!mergedMaster.prob.includes("納品済")) mergedMaster.prob.push("納品済");
      if(Array.isArray(mergedMaster.status)) mergedMaster.status = mergedMaster.status.filter(function(x){return x!=="納品済";});
      MASTER = mergedMaster;
    }
    if(mergedPw){ localStorage.setItem("kenmei_pw_v7", mergedPw); }
    if(mergedDeleted && typeof mergedDeleted === "object"){ DELETED_IDS = mergedDeleted; saveDeleted(); }
    if(mergedMasterDeleted && typeof mergedMasterDeleted === "object"){ MASTER_DELETED_IDS = mergedMasterDeleted; saveMasterDeleted(); }
    saveCases();
    saveMaster();
    if(typeof rebuildAll === "function") rebuildAll();
    if(typeof buildFilters === "function") buildFilters();
    if(typeof renderList === "function") renderList();
    if(typeof renderMgCases === "function") renderMgCases();
    if(typeof renderMg === "function"){
      var mgOn = document.getElementById("sub-mg-dropdown");
      if(mgOn && mgOn.classList.contains("on")) renderMg();
    }
    _suppressPush = false;
  }

  // ---------------- 通信本体 ----------------
  function gasFetch(url, opts){
    return fetch(url, opts).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // ---------------- 二段階同期（レースコンディション対策） ----------------
  // 【背景】GAS側はLockServiceで「同時に2件の保存処理が同時実行されない」ことは保証するが、
  // 「先に操作した人の処理が必ず先に完了する」ことまでは保証しない。そのため、ほぼ同時刻に
  // 複数の利用者が同期操作を行うと、ネットワーク遅延等により後から操作した人のリクエストが
  // 先にサーバーに到達・処理されてしまうことがある。この場合、先に処理された側は「まだ他の人の
  // 変更が反映される前の一瞬のサーバー状態」を取得してしまい、そのままローカルに反映して
  // 同期を終えてしまう（サーバー自体は最終的に正しい状態になるが、その端末だけ古い状態のまま
  // 残り続ける）。これを軽減するため、「今すぐサーバーへ送信・同期」「サーバーの内容を取得して
  // 統合」のいずれかが正常に完了した数秒後、もう一度サーバー状態を静かに確認・再取得する
  // 「二段階同期」を行う。ほぼ同時に発生した他の利用者の変更も、この確認取得のタイミングまでには
  // サーバーへの書き込みが完了している可能性が高いため、取りこぼしを大幅に減らせる。
  var CONFIRM_PULL_DELAY_MS = 4000;
  var _confirmPullTimer = null;
  function scheduleConfirmPull(){
    clearTimeout(_confirmPullTimer);
    _confirmPullTimer = setTimeout(function(){
      doLoadFromServer({ silent:true, isConfirmPull:true });
    }, CONFIRM_PULL_DELAY_MS);
  }

  // サーバーからの取得・マージの共通処理本体（gasLoadFromServer・二段階同期の確認取得の両方から使う）
  // opts: { silent: 真偽値（trueなら通常時のメッセージ表示を抑制。安全装置のアラートは常に表示）,
  //         isConfirmPull: 真偽値（二段階同期による自動確認取得の場合はtrue。この場合は
  //         さらに次の確認取得は予約しない＝無限ループを防止） }
  function doLoadFromServer(opts){
    opts = opts || {};
    var cfg = gasConfig();
    if(!cfg.url){
      if(!opts.silent) setMsg("サーバーURLが設定されていません。先に「サーバー連携(GAS)」で設定してください。", "err");
      return Promise.resolve(false);
    }
    if(!opts.silent) setMsg("サーバーから取得中...", "");
    var qs = "?action=load&token=" + encodeURIComponent(cfg.token || "");
    return gasFetch(cfg.url + qs, { method: "GET" }).then(function(res){
      if(!res || !res.ok) throw new Error((res && res.error) || "不明なエラー");
      var d = res.data || {};
      var mergedDeletedPre = mergeDeletedIdsClient(DELETED_IDS, d.deletedIds || {});
      var mergedMasterDeleted = mergeMasterDeletedIdsClient(MASTER_DELETED_IDS, d.masterDeletedIds || {});
      var caseMergeResult = mergeCasesClient(CASES, d.cases || [], mergedDeletedPre);
      var mergedCases = caseMergeResult.cases;
      var mergedDeleted = caseMergeResult.deletedIds; // 自己修復後の削除記録
      var masterMergeResult = mergeMasterClient(MASTER, d.master || null, mergedMasterDeleted);
      var mergedMaster = masterMergeResult.master;
      mergedMasterDeleted = masterMergeResult.masterDeletedIds; // 自己修復後の削除記録

      // サーバー側と同じ安全装置：統合結果がサーバー側・ローカル側どちらよりも
      // 大幅に少ない場合は、この端末のデータを書き換えずに中止する。
      var beforeCountL = Math.max(CASES.length, (d.cases || []).length);
      var afterCountL = mergedCases.length;
      if(beforeCountL >= 3 && afterCountL < beforeCountL * 0.5){
        var m2 = "⚠ 安全装置により取得・統合を中止しました（この端末のデータは変更されていません）。\n" +
          "サーバー側件数: " + (d.cases||[]).length + "件 / この端末の件数: " + CASES.length + "件 / " +
          "統合されるはずだった件数: " + afterCountL + "件" +
          "\n\nこのメッセージが表示された場合は同期を行わず、開発担当へご連絡ください。";
        setMsg(m2, "err");
        window.alert(m2);
        return false;
      }

      afterServerAdopt(mergedCases, mergedMaster, d.pw, mergedDeleted, mergedMasterDeleted);
      setLastSync();
      if(!opts.silent){
        setMsg("サーバーの内容を取得・統合しました（件名 " + mergedCases.length + "件）。", "ok");
      }
      // 二段階同期：この呼び出し自体が「確認取得」でなければ、数秒後にもう一度確認取得を予約する
      // （確認取得自身からはさらに次の確認取得を予約しない＝無限ループ防止）
      if(!opts.isConfirmPull) scheduleConfirmPull();
      return true;
    }).catch(function(err){
      if(!opts.silent) setMsg("取得に失敗しました: " + err.message, "err");
      return false;
    });
  }

  // サーバーへ送信（ローカル→サーバーへpush、サーバー側でマージ後の確定データを受け取って採用＝双方向同期）
  window.gasSaveToServer = function(silent){
    var cfg = gasConfig();
    if(!cfg.url){ if(!silent) setMsg("サーバーURLが設定されていません。先に「サーバー連携(GAS)」で設定してください。", "err"); return Promise.resolve(false); }
    if(!silent) setMsg("サーバーへ送信中...", "");
    var body = {
      action: "save",
      token: cfg.token,
      cases: CASES,
      master: MASTER,
      pw: getPassword(),
      deletedIds: DELETED_IDS,
      masterDeletedIds: MASTER_DELETED_IDS
    };
    return gasFetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    }).then(function(res){
      // ---- 安全装置：サーバー側で「異常な件数減少」を検知して書き込みを中止した場合。
      // この場合、サーバー・ローカルのどちらのデータも変更されていない（safe abort）。
      if(res && res.ok === false && res.error === "abnormal_drop_blocked"){
        var diag = res.diagnostics || {};
        var exampleTxt = (diag.missingExamples && diag.missingExamples.length)
          ? ("\n消えかけていた件名の例:\n・" + diag.missingExamples.join("\n・"))
          : "";
        var m = "⚠ 安全装置により同期を中止しました（データは変更されていません）。\n" +
          "サーバー側件数: " + (diag.serverCountBefore != null ? diag.serverCountBefore : "?") + "件 / " +
          "この端末の送信件数: " + (diag.clientSentCount != null ? diag.clientSentCount : "?") + "件 / " +
          "統合されるはずだった件数: " + (diag.mergedCountWouldBe != null ? diag.mergedCountWouldBe : "?") + "件" +
          exampleTxt +
          "\n\nこのメッセージが表示された場合は同期を行わず、開発担当へご連絡ください。";
        setMsg(m, "err");
        window.alert(m);
        return false;
      }
      if(!res || !res.ok) throw new Error((res && res.error) || "不明なエラー");
      var d = res.data || {};
      afterServerAdopt(d.cases, d.master, d.pw, d.deletedIds, d.masterDeletedIds);
      setLastSync();
      if(!silent) setMsg("サーバーと同期しました（件名 " + (d.cases||[]).length + "件）。", "ok");
      // 二段階同期：送信直後はまだ他の利用者のほぼ同時刻の変更が反映されていない可能性が
      // あるため、数秒後にもう一度サーバー状態を静かに確認・取得し直す。
      scheduleConfirmPull();
      return true;
    }).catch(function(err){
      if(!silent) setMsg("同期に失敗しました: " + err.message, "err");
      return false;
    });
  };

  // サーバーの内容のみ取得（ローカルの未送信の変更は残し、クライアント側でマージ）
  window.gasLoadFromServer = function(silent){
    return doLoadFromServer({ silent: !!silent });
  };

  // ローカル（localStorage）の件名データ・マスタ・削除トゥームストーン等を全消去し、
  // サーバー上の最新データのみを取得して置き換える（マージせず完全上書き）。
  window.gasResetAndLoadFromServer = function(){
    var cfg = gasConfig();
    if(!cfg.url){ setMsg("サーバーURLが設定されていません。先に「サーバー連携(GAS)」で設定してください。", "err"); return Promise.resolve(false); }
    setMsg("サーバーから取得中...", "");
    var qs = "?action=load&token=" + encodeURIComponent(cfg.token || "");
    return gasFetch(cfg.url + qs, { method: "GET" }).then(function(res){
      if(!res || !res.ok) throw new Error((res && res.error) || "不明なエラー");
      var d = res.data || {};
      // マージせず、サーバー側のデータで完全に上書きする（ローカルの未送信変更・削除トゥームストーンも破棄）
      DELETED_IDS = d.deletedIds || {};
      saveDeleted();
      MASTER_DELETED_IDS = d.masterDeletedIds || {};
      saveMasterDeleted();
      afterServerAdopt(d.cases || [], d.master || null, d.pw, DELETED_IDS, MASTER_DELETED_IDS);
      setLastSync();
      setMsg("ローカルを全消去し、サーバーの内容を取得しました（件名 " + (d.cases||[]).length + "件）。", "ok");
      return true;
    }).catch(function(err){
      setMsg("取得に失敗しました: " + err.message, "err");
      return false;
    });
  };

  // サーバー上のデータを全消去し、このブラウザ（ローカル）の内容で完全に置き換える。
  // マージせずローカル→サーバーへ一方的に上書きする（⑤メンテナンス専用機能）。
  window.gasOverwriteServerWithLocal = function(){
    var cfg = gasConfig();
    if(!cfg.url){ setMsg("サーバーURLが設定されていません。先に「サーバー連携(GAS)」で設定してください。", "err"); return Promise.resolve(false); }
    setMsg("サーバーへ送信中...", "");
    var body = {
      action: "overwrite",
      token: cfg.token,
      cases: CASES,
      master: MASTER,
      pw: getPassword(),
      deletedIds: DELETED_IDS,
      masterDeletedIds: MASTER_DELETED_IDS
    };
    return gasFetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    }).then(function(res){
      if(!res || !res.ok) throw new Error((res && res.error) || "不明なエラー");
      var d = res.data || {};
      setLastSync();
      setMsg("サーバーを全消去し、ローカルの内容で上書きしました（件名 " + (d.cases||[]).length + "件）。", "ok");
      return true;
    }).catch(function(err){
      setMsg("送信に失敗しました: " + err.message, "err");
      return false;
    });
  };

  // ---------------- 自動同期（保存操作のたびに一定時間後へ送信） ----------------
  var _pushTimer = null;
  function gasSchedulePush(){
    if(_suppressPush) return; // サーバーから取得・統合した直後の再送信ループを防止
    var cfg = gasConfig();
    if(!cfg.auto || !cfg.url) return;
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(function(){ window.gasSaveToServer(true); }, 2500);
  }
  window.afterLocalSave = function(){ gasSchedulePush(); };

  // ---------------- 設定UIの初期化 （ページ内の複数の場所に同じUIを設置していてもすべてを同期する） ----------------
  function syncAllConfigInputs(){
    var cfg = gasConfig();
    document.querySelectorAll(".gas-url-input").forEach(function(el){ el.value = cfg.url; });
    document.querySelectorAll(".gas-token-input").forEach(function(el){ el.value = cfg.token; });
    document.querySelectorAll(".gas-autosync-input").forEach(function(el){ el.checked = cfg.auto; });
  }
  function initUI(){
    syncAllConfigInputs();
    refreshLastSyncLabel();

    document.querySelectorAll('[data-gas-action="saveConfig"]').forEach(function(btn){
      btn.addEventListener("click", function(){
        var step = btn.closest(".gas-step");
        if(!step){
          setMsg("設定フォームが見つかりませんでした（画面の構成に問題がある可能性があります）。", "err");
          return;
        }
        var urlEl   = step.querySelector(".gas-url-input");
        var tokenEl = step.querySelector(".gas-token-input");
        var autoEl  = step.querySelector(".gas-autosync-input");
        if(!urlEl || !tokenEl || !autoEl){
          setMsg("設定の入力欄が見つかりませんでした（画面の構成に問題がある可能性があります）。", "err");
          return;
        }
        var ok = gasSetConfig(urlEl.value.trim(), tokenEl.value.trim(), autoEl.checked);
        if(!ok){
          setMsg("⚠ 設定を保存できませんでした。ブラウザのプライベートブラウジングモードや、" +
            "ストレージを制限する設定が有効になっている可能性があります。通常モードでの" +
            "ご利用をお試しください。", "err");
          return;
        }
        syncAllConfigInputs(); // 他の設定入力欄（別タブ等）へも反映
        setMsg("設定を保存しました。", "ok");
      });
    });
    document.querySelectorAll('[data-gas-action="sync"]').forEach(function(btn){
      btn.addEventListener("click", function(){ window.gasSaveToServer(false); });
    });
    document.querySelectorAll('[data-gas-action="load"]').forEach(function(btn){
      btn.addEventListener("click", function(){ window.gasLoadFromServer(); });
    });
    document.querySelectorAll('[data-gas-action="resetLoad"]').forEach(function(btn){
      btn.addEventListener("click", function(){
        var cfg = gasConfig();
        if(!cfg.url){ setMsg("サーバーURLが設定されていません。先に「サーバー連携(GAS)」で設定してください。", "err"); return; }
        var ok = window.confirm(
          "このブラウザに保存されている件名データ・マスタ設定などを全て消去し、\n" +
          "サーバー上の最新データに置き換えます。\n\n" +
          "この端末でまだサーバーへ送信していない変更がある場合、その変更は失われます。\n" +
          "本当に実行しますか？"
        );
        if(!ok) return;
        window.gasResetAndLoadFromServer();
      });
    });
    document.querySelectorAll('[data-gas-action="overwriteServer"]').forEach(function(btn){
      btn.addEventListener("click", function(){
        var cfg = gasConfig();
        if(!cfg.url){ setMsg("サーバーURLが設定されていません。先に「サーバー連携(GAS)」で設定してください。", "err"); return; }
        var ok = window.confirm(
          "サーバー上に保存されている件名データ・マスタ設定などを全て消去し、\n" +
          "このブラウザ（ローカル）の内容に置き換えます。\n\n" +
          "他の人がまだサーバーへ送信していない変更や、サーバー上にのみ存在するデータは\n" +
          "すべて失われます。他の利用者にも影響する操作です。\n" +
          "本当に実行しますか？"
        );
        if(!ok) return;
        window.gasOverwriteServerWithLocal();
      });
    });
    document.querySelectorAll('[data-gas-action="testConn"]').forEach(function(btn){
      btn.addEventListener("click", function(){
        var urlEl   = btn.closest(".gas-step").querySelector(".gas-url-input");
        var tokenEl = btn.closest(".gas-step").querySelector(".gas-token-input");
        var url = urlEl.value.trim();
        if(!url){ setMsg("URLを入力してください。", "err"); return; }
        setMsg("接続テスト中...", "");
        var qs = "?action=load&token=" + encodeURIComponent(tokenEl.value.trim() || "");
        gasFetch(url + qs, { method: "GET" }).then(function(res){
          if(res && res.ok){ setMsg("接続成功。サーバー上の件名数: " + ((res.data && res.data.cases) || []).length + "件", "ok"); }
          else { setMsg("接続はできましたが応答が不正です: " + ((res && res.error) || ""), "err"); }
        }).catch(function(err){ setMsg("接続失敗: " + err.message, "err"); });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function(){
    initUI();
    // ページ起動時、GAS設定済みで自動同期ONなら静かに1回同期する
    var cfg = gasConfig();
    if(cfg.url && cfg.auto){
      setTimeout(function(){ window.gasLoadFromServer(); }, 600);
    }
  });
})();
