// 拡張機能アイコンの番組一覧UI（popup / side panel 共用）
// タブ構成: お気に入りフォロー / フォロー中 / 終了済み履歴 / ちくらん

// ===== 定数 =====

// API
const API_FOLLOW_ONAIR  = 'https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair';
const API_FOLLOW_CLOSED = 'https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=closed&offset=';
const URL_CHIKURAN       = 'http://www.chikuwachan.com/live/NCU/';

// 自動更新の間隔
const FAVO_REFRESH_MS     = 30 * 1000;      // お気に入り: 30秒
const CHIKURAN_REFRESH_MS = 1 * 60 * 1000;  // ちくらん: 1分

// 画像取得失敗時のフォールバック
const FALLBACK_THUMBNAIL = 'https://nicolive.cdn.nimg.jp/tsthumb/thumbnail/241026/01/21/pg54488467505735_640_360.jpg';
const FALLBACK_USER_ICON = 'https://secure-dcdn.cdn.nimg.jp/comch/community-icon/64x64/.jpg?';

// 番組行の右端アイコン（お気に入り解除 / お気に入り追加 / フィルタ）
const ICON_UNFAVO = '<svg class="unfavoIcon" style=" display:none;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path style="fill:gray;" d="M0 256C0 114.6 114.6 0 256 0C397.4 0 512 114.6 512 256C512 397.4 397.4 512 256 512C114.6 512 0 397.4 0 256zM159.3 388.7C171.5 349.4 209.9 320 256 320C302.1 320 340.5 349.4 352.7 388.7C355.3 397.2 364.3 401.9 372.7 399.3C381.2 396.7 385.9 387.7 383.3 379.3C366.8 326.1 315.8 287.1 256 287.1C196.3 287.1 145.2 326.1 128.7 379.3C126.1 387.7 130.8 396.7 139.3 399.3C147.7 401.9 156.7 397.2 159.3 388.7H159.3zM176.4 176C158.7 176 144.4 190.3 144.4 208C144.4 225.7 158.7 240 176.4 240C194 240 208.4 225.7 208.4 208C208.4 190.3 194 176 176.4 176zM336.4 240C354 240 368.4 225.7 368.4 208C368.4 190.3 354 176 336.4 176C318.7 176 304.4 190.3 304.4 208C304.4 225.7 318.7 240 336.4 240z"/></svg>';
const ICON_FAVO = '<svg class="favoIcon" style="display:none;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path style="fill:orange;" d="M381.2 150.3L524.9 171.5C536.8 173.2 546.8 181.6 550.6 193.1C554.4 204.7 551.3 217.3 542.7 225.9L438.5 328.1L463.1 474.7C465.1 486.7 460.2 498.9 450.2 506C440.3 513.1 427.2 514 416.5 508.3L288.1 439.8L159.8 508.3C149 514 135.9 513.1 126 506C116.1 498.9 111.1 486.7 113.2 474.7L137.8 328.1L33.58 225.9C24.97 217.3 21.91 204.7 25.69 193.1C29.46 181.6 39.43 173.2 51.42 171.5L195 150.3L259.4 17.97C264.7 6.954 275.9-.0391 288.1-.0391C300.4-.0391 311.6 6.954 316.9 17.97L381.2 150.3z"/></svg>';
const ICON_FILTER = '<svg class="filterIcon" style="display:none;" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="24" height="24" viewBox="0 0 256 256" xml:space="preserve"><defs></defs><g style="stroke: none; stroke-width: 0; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: none; fill-rule: nonzero; opacity: 1;" transform="translate(1.4065934065934016 1.4065934065934016) scale(2.81 2.81)" ><path d="M 38.047 90 c -0.507 0 -1.015 -0.128 -1.472 -0.386 c -0.944 -0.532 -1.528 -1.531 -1.528 -2.614 V 45.698 L 4.044 4.813 C 3.356 3.905 3.242 2.686 3.748 1.666 C 4.255 0.645 5.296 0 6.435 0 h 77.129 c 1.14 0 2.18 0.645 2.687 1.666 c 0.507 1.02 0.393 2.239 -0.296 3.147 L 54.952 45.698 v 32.873 c 0 1.049 -0.548 2.021 -1.445 2.565 l -13.904 8.429 C 39.125 89.854 38.586 90 38.047 90 z M 12.475 6 l 27.963 36.877 c 0.396 0.521 0.609 1.158 0.609 1.813 v 36.984 l 7.905 -4.792 V 44.689 c 0 -0.654 0.214 -1.291 0.609 -1.813 L 77.524 6 H 12.475 z M 51.952 78.571 h 0.01 H 51.952 z" style="stroke: none; stroke-width: 1; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: rgb(0,0,0); fill-rule: nonzero; opacity: 1;" transform=" matrix(1 0 0 1 0 0) " stroke-linecap="round" /></g></svg>';

// ===== 状態 =====

let notFavolist;     // お気に入り除外リスト（番組提供者名の配列）
let liveList;        // 配信中番組のキャッシュ（menu1 取得分を menu2 で再利用）
let tm;              // サムネのフレーム取得用インターバル
let tmHover;         // ホバー中アニメーション用インターバル
const frameBuffers = new Map();

// 自動更新タイマー関連
let refreshTimer = null;          // setTimeout ハンドル
let isPaused = false;             // 一時停止中かどうか
let pausedRemainingMs = 0;        // 一時停止時点での残り時間
let refreshStartTime = 0;         // 現在サイクル開始時刻
let currentIntervalMs = 0;        // 現在の更新間隔
let currentLoadFn = null;         // 現在の更新関数
let currentPauseOnScroll = false; // スクロール時に一時停止するか

// ===== 初期化 =====

$(function () {
	//localStorage.removeItem('notFavolist');
	notFavolist = localStorage.getItem('notFavolist');
	notFavolist = notFavolist ? JSON.parse(notFavolist) : [];

	// 番組リンク / ユーザーリンクは委譲で一度だけバインド（各一覧の再描画後も有効）
	$(document).on('click', '.liveLink', function () {
		openInTab($(this).attr('href'));
		return false;
	});
	$(document).on('click', '.userLink', function (e) {
		e.preventDefault();
		e.stopPropagation();
		window.open($(this).attr('url'));
	});

	// favoList: ホバーでお気に入り解除アイコン表示 / クリックで解除
	$('#favoList').on('mouseenter', '.liveLink', function () {
		$(this).find('.unfavoIcon').show();
	}).on('mouseleave', '.liveLink', function () {
		$(this).find('.unfavoIcon').hide();
	}).on('click', '.unfavo', function (e) {
		e.preventDefault();
		e.stopPropagation();
		notFavolist.push($(this).attr('userId'));
		localStorage.setItem('notFavolist', JSON.stringify(notFavolist));
		$(this).closest('a').animate({ opacity: 0 }, 500, function () { $(this).hide(); });
	});

	// liveList: ホバーでお気に入り追加アイコン表示 / クリックで追加
	$('#liveList').on('mouseenter', '.liveLink', function () {
		$(this).find('.favoIcon').show();
	}).on('mouseleave', '.liveLink', function () {
		$(this).find('.favoIcon').hide();
	}).on('click', '.favo', function (e) {
		e.preventDefault();
		e.stopPropagation();
		notFavolist = notFavolist.filter(a => a !== $(this).attr('userId'));
		localStorage.setItem('notFavolist', JSON.stringify(notFavolist));
		$(this).closest('a').animate({ opacity: 0 }, 500, function () { $(this).hide(); });
	});

	// closedList: ホバーでフィルタアイコン表示
	$('#closedList').on('mouseenter', '.liveRow', function () {
		$(this).find('.filterIcon').show();
	}).on('mouseleave', '.liveRow', function () {
		$(this).find('.filterIcon').hide();
	});

	loadFavoList();
	startAutoRefresh(loadFavoList, FAVO_REFRESH_MS); // 初期タブ（favo）の自動更新を開始

	$('#menu1').click(function () {
		clearRefresh();
		stopAutoRefresh();
		$(window).off(); // closedList の無限スクロールハンドラを解除
		window.scrollTo(0, 0);
		$('#favoList').scrollTop(0);
		loadFavoList();
		startAutoRefresh(loadFavoList, FAVO_REFRESH_MS);
	});
	$('#menu2').click(function () {
		clearRefresh();
		stopAutoRefresh();
		$(window).off();
		window.scrollTo(0, 0);
		$('#liveList').scrollTop(0);
		loadLiveList();
	});
	$('#menu3').click(function () {
		clearRefresh();
		stopAutoRefresh();
		$(window).off();
		window.scrollTo(0, 0);
		$('#closedList').scrollTop(0).attr('offset', 0);
		loadClosedList();
		initClosedListMore();
	});
	$('#menu4').click(function () {
		clearRefresh();
		stopAutoRefresh();
		$(window).off();
		window.scrollTo(0, 0);
		$('#chikuranList').scrollTop(0);
		loadChikuranList();
		startAutoRefresh(loadChikuranList, CHIKURAN_REFRESH_MS, { pauseOnScroll: true });
	});

	$('.closeButton').off().click(() => {
		window.close();
	});
});

// ===== 共通ヘルパー =====

// 番組提供者（ユーザー or チャンネル）の表示情報を取り出す
function getProvider(info) {
	if (info.programProvider) {
		return {
			name: info.programProvider.name,
			userUrl: 'https://www.nicovideo.jp/user/' + info.programProvider.id,
			userIcon: info.programProvider.icon,
		};
	}
	return {
		name: info.socialGroup.name,
		userUrl: 'https://ch.nicovideo.jp/' + info.socialGroup.id,
		userIcon: info.socialGroup.thumbnailUrl,
	};
}

// 同一ホストなら現在のタブで開き、別ホストなら新規タブで開く
function openInTab(url) {
	chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
		var tab = tabs[0];
		var currentUrl = new URL(tab.url);
		if (currentUrl.hostname === new URL(url).hostname) {
			chrome.tabs.update(tab.id, { url: url });
		} else {
			chrome.tabs.create({ url: url });
		}
	});
}

// 番組行の右端アイコン（クラス名・SVG・対象ユーザー名）
function sideIcon(cls, svg, name) {
	return `<div class="${cls}" userId="${name}" style="position:relative; width:24px; right:24px;">${svg}</div>`;
}

// ニコ生番組の1行HTMLを生成（variant: 'favo' | 'live' | 'closed'）
// data-url / data-begin-at を付与し、差分更新のキーとして使用する
function buildNicoRow(info, variant) {
	const p = getProvider(info);
	const now = Date.now();

	let elapsed, rightIcon, nameClass = '', titleExtra = '', anchorStyle = '';
	if (variant === 'favo') {
		elapsed = `${toHms((now - info.beginAt) / 1000)} 経過`;
		rightIcon = sideIcon('unfavo', ICON_UNFAVO, p.name);
	} else if (variant === 'live') {
		elapsed = `${toHms((now - info.beginAt) / 1000)} ／ ${formatDate(info.endAt)} 経過`;
		rightIcon = sideIcon('favo', ICON_FAVO, p.name);
	} else { // closed
		elapsed = `${toHms((info.endAt - info.beginAt) / 1000)} ／ ${formatDate(info.endAt)} 終了`;
		rightIcon = sideIcon('filter', ICON_FILTER, p.name);
		nameClass = 'name';
		titleExtra = ' word-break:break-all;';
		anchorStyle = (!favOnly || !notFavolist.includes(p.name)) ? '' : 'display:none;';
	}

	return `
		<a href="${info.watchPageUrl}" class="liveLink" data-url="${info.watchPageUrl}" data-begin-at="${info.beginAt}"${anchorStyle ? ` style="${anchorStyle}"` : ''}>
			<div class="row mt-1 mb-1 pt-1 pb-1 pr-1 d-flex align-items-center liveRow">
				<div class="thum col-4" style="max-width:9.5rem;">
					<img class="live" src="${info.listingThumbnail}" style="height:64px; background-color:#eee;">
				</div>
				<div class="col pl-1">
					<div class="row" style="font-size:10px; color:#252525; height:2rem; line-height:2rem; align-items: center;">
						<span class="userLink" url="${p.userUrl}">
							<img class="user" src="${p.userIcon}" style="width:1.5rem; margin-right:.3rem; border-radius:100%; line-height:2rem;">
						</span>
						<span class="${nameClass}" style="text-overflow: ellipsis;
									display: block;
									width: calc(100% - 2rem);
									white-space: nowrap;
									overflow-x: hidden;">
									${p.name}
						</span>
					</div>
					<div class="row pr-3 pb-1 prog-title" style="font-weight:bold;${titleExtra}">
						${info.title}
					</div>
					<div class="row elapsed" style="font-size:10px; color:#252525">
						${elapsed}
					</div>
				</div>
				${rightIcon}
			</div>
		</a>
	`;
}

// 一覧内のサムネイル読み込み失敗時にフォールバック画像を差し込む
// urls は対象 img と同順の URL 配列（先頭から消費する）
function applyThumbnailFallback(imgSelector, urls, fallback) {
	$(imgSelector).each((i, el) => {
		$.get(urls[0]).fail(() => {
			$(el).attr('src', fallback);
		});
		urls.shift();
	});
}

// 取得失敗時の共通メッセージ表示
function showListError($container, message) {
	$container.html(`
		<div class="pt-5 pb-5 pl-4">
			${message}
		</div>
	`);
}

// ===== サムネイルアニメーション用リソース管理 =====

// アニメーション用インターバル・フレームバッファを全クリア（タブ切り替え時に呼ぶ）
function clearRefresh() {
	clearInterval(tm);
	clearInterval(tmHover);
	frameBuffers.forEach(buf => buf.urls.forEach(u => URL.revokeObjectURL(u)));
	frameBuffers.clear();
}

// ===== 自動更新 / プログレスバー =====

// 指定の一覧を intervalMs ごとに自動更新し、プログレスバーで残り時間を可視化する
// options.pauseOnScroll = true のとき、スクロールがトップ以外では一時停止する
function startAutoRefresh(loadFn, intervalMs, options = {}) {
	stopAutoRefresh();
	currentLoadFn = loadFn;
	currentIntervalMs = intervalMs;
	currentPauseOnScroll = options.pauseOnScroll || false;
	isPaused = false;

	if (currentPauseOnScroll) {
		$(window).on('scroll.autoRefreshPause', onScrollPause);
		$('#chikuranList').on('scroll.autoRefreshPause', onScrollPause);
	}

	runRefreshCycle(intervalMs);
}

// 残り remainingMs ミリ秒でカウントダウン開始（再開時にも使用）
function runRefreshCycle(remainingMs) {
	const $bar = $('#autoRefreshProgress');
	const $barContainer = $('#autoRefreshProgressBar');
	const progressPct = ((currentIntervalMs - remainingMs) / currentIntervalMs) * 100;

	// バーを現在の進捗位置にリセット後、残り時間分だけ linear で 100% まで伸ばす
	$bar.css({ transition: 'none', width: `${progressPct}%` });
	$barContainer.show();
	void ($bar[0] && $bar[0].offsetWidth); // force reflow
	$bar.css({ transition: `width ${remainingMs}ms linear`, width: '100%' });

	refreshStartTime = Date.now();
	pausedRemainingMs = remainingMs;

	refreshTimer = setTimeout(function () {
		// 更新前にリストをトップへ戻す
		window.scrollTo(0, 0);
		$('div.liveList').scrollTop(0);
		currentLoadFn();
		runRefreshCycle(currentIntervalMs);
	}, remainingMs);
}

// カウントダウンを一時停止（スクロール離脱時）
function pauseAutoRefresh() {
	if (isPaused || !refreshTimer) return;
	isPaused = true;

	const elapsed = Date.now() - refreshStartTime;
	pausedRemainingMs = Math.max(0, pausedRemainingMs - elapsed);

	clearTimeout(refreshTimer);
	refreshTimer = null;

	// プログレスバーをその場で止める
	const $bar = $('#autoRefreshProgress');
	const progressPct = ((currentIntervalMs - pausedRemainingMs) / currentIntervalMs) * 100;
	$bar.css({ transition: 'none', width: `${progressPct}%` });
}

// カウントダウンを再開（スクロールがトップへ戻ったとき）
function resumeAutoRefresh() {
	if (!isPaused) return;
	isPaused = false;
	runRefreshCycle(pausedRemainingMs);
}

// スクロール位置を監視し、トップ以外で一時停止、トップへ戻ったら再開
function onScrollPause() {
	const atTop = window.scrollY === 0 && $('#chikuranList').scrollTop() === 0;
	if (!atTop && !isPaused) {
		pauseAutoRefresh();
	} else if (atTop && isPaused) {
		resumeAutoRefresh();
	}
}

// 自動更新を完全停止してプログレスバーを隠す
function stopAutoRefresh() {
	clearTimeout(refreshTimer);
	refreshTimer = null;
	isPaused = false;
	pausedRemainingMs = 0;
	currentLoadFn = null;
	currentPauseOnScroll = false;

	$(window).off('scroll.autoRefreshPause');
	$('#chikuranList').off('scroll.autoRefreshPause');

	$('#autoRefreshProgress').css({ transition: 'none', width: '0%' });
	$('#autoRefreshProgressBar').hide();
}

// ===== サムネイルのホバーアニメーション =====

// containerId 配下の img.live を対象にフレームをバッファリングし、ホバー時にアニメーション再生する
// 差分更新で追加された新規行も delegation により自動でアニメーション対象となる
function startLiveAnimation(containerId) {
	// 既存のフェッチインターバルを停止（frameBuffers は保持する — 差分更新時に既存データを活かすため）
	clearInterval(tm);
	clearInterval(tmHover);

	// まだ登録されていない img.live 要素だけ frameBuffers に追加
	$(`${containerId} img.live`).each((i, el) => {
		if (!frameBuffers.has(el)) {
			el.setAttribute('data-original-src', el.src.replace(/\?t=\d+$/, ''));
			frameBuffers.set(el, { urls: [], idx: 0, lastSize: 0 });
		}
	});

	async function fetchAllFrames() {
		const imgs = $(`${containerId} img.live`).toArray();
		await Promise.all(imgs.map(async el => {
			const buf = frameBuffers.get(el);
			if (!buf) return;
			const src = el.getAttribute('data-original-src');
			try {
				const res = await fetch(src + '?t=' + Date.now());
				if (!res.ok) return;
				const blob = await res.blob();
				if (blob.size === buf.lastSize) return;
				buf.lastSize = blob.size;
				const url = URL.createObjectURL(blob);
				buf.urls.push(url);
				if (buf.urls.length > 5) URL.revokeObjectURL(buf.urls.shift());
				if (el.dataset.hovered !== '1') {
					el.src = url;
				}
			} catch(e) {}
		}));
	}

	fetchAllFrames();
	tm = setInterval(fetchAllFrames, 2000);

	// 委譲バインド: 差分更新で後から追加された行にも有効
	$(containerId).off('.liveAnim')
		.on('mouseenter.liveAnim', '.liveLink', function () {
			const img = $(this).find('img.live')[0];
			if (!img) return;

			clearInterval(tmHover);
			$(`${containerId} img.live`).removeAttr('data-hovered');
			img.dataset.hovered = '1';

			const buf = frameBuffers.get(img);
			if (buf && buf.urls.length > 0) {
				buf.idx = 0;
				img.src = buf.urls[0];
			}

			tmHover = setInterval(() => {
				const buf = frameBuffers.get(img);
				if (!buf || buf.urls.length === 0) return;
				buf.idx = (buf.idx + 1) % buf.urls.length;
				img.src = buf.urls[buf.idx];
			}, 500);
		})
		.on('mouseleave.liveAnim', '.liveLink', function () {
			const img = $(this).find('img.live')[0];
			if (!img) return;
			clearInterval(tmHover);
			delete img.dataset.hovered;
			const buf = frameBuffers.get(img);
			if (buf && buf.urls.length > 0) {
				img.src = buf.urls[buf.urls.length - 1];
			}
		});
}

// ===== お気に入りフォロー（配信中） =====

// favoList を差分更新する（追加・削除・タイトル/経過時間の更新）
function diffUpdateFavoList(newList) {
	const $container = $('#favoList');

	// スピナーなど liveLink 以外の要素を除去（初回ロード時のローディング表示を消す）
	$container.children(':not(a.liveLink)').remove();

	if (newList.length === 0) {
		showListError($container, '放送中の番組がありません。');
		return;
	}

	const now = Date.now();
	const newUrlSet = new Set(newList.map(i => i.watchPageUrl));

	// 新しいリストに存在しない行を削除
	$container.find('a.liveLink').each(function () {
		if (!newUrlSet.has($(this).attr('data-url'))) {
			$(this).remove();
		}
	});

	// 既存行の更新 / 新規行の追加
	for (const info of newList) {
		const p = getProvider(info);
		if (notFavolist.includes(p.name)) continue; // お気に入り除外リストはスキップ

		const $existing = $container.find(`a.liveLink[data-url="${info.watchPageUrl}"]`);
		if ($existing.length) {
			// タイトルと経過時間をその場で更新
			$existing.find('.prog-title').html(info.title);
			$existing.find('.elapsed').text(`${toHms((now - info.beginAt) / 1000)} 経過`);
		} else {
			// 新規行: HTMLを追加してサムネイルフォールバックを設定
			const html = buildNicoRow(info, 'favo');
			$container.append(html);
			const img = $container.find(`a.liveLink[data-url="${info.watchPageUrl}"]`).find('img.live')[0];
			if (img) {
				$.get(info.listingThumbnail).fail(() => $(img).attr('src', FALLBACK_THUMBNAIL));
			}
		}
	}
}

function loadFavoList() {
	$.get(API_FOLLOW_ONAIR)
	.done(function (res) {
		if (!res.data) return;

		liveList = res.data.programs; // menu2 で再利用するためキャッシュ
		diffUpdateFavoList(liveList);
		startLiveAnimation('#favoList');
	})
	.fail(function () {
		showListError($('#favoList'), '番組リストの取得に失敗しました。<br>ニコニコにログインしているか確認してください。');
	});
}

// ===== フォロー中（配信中・お気に入り除外分） =====

function loadLiveList() {
	let list = liveList;
	$('#liveList').empty();

	if (!list || 0 == list.length) {
		showListError($('#liveList'), '放送中の番組がありません。');
		return;
	}

	let listHtml = '';
	let thumbnails = [];
	for (let info of list) {
		let name = getProvider(info).name;
		thumbnails.push(info.listingThumbnail);
		if (notFavolist.includes(name)) {
			listHtml += buildNicoRow(info, 'live');
		}
	}
	$('#liveList').append(listHtml);

	applyThumbnailFallback('#liveList img.live', thumbnails, FALLBACK_THUMBNAIL);
	startLiveAnimation('#liveList');
	// ホバー / お気に入り追加クリック は $(function) 内の委譲バインドで処理
}

// ===== 終了済み番組履歴 =====

let closedFilter = null; // 特定ユーザーで絞り込み中の名前
let favOnly = true;      // お気に入りのみ表示するか

function initClosedListMore() {
	let offset = Number($('#closedList').attr('offset'));
	$(window).off().on("wheel scroll", function () {
		if (offset < 10) {
			if (window.pageYOffset + window.innerHeight + 500 >= $("#closedList").height()
				|| window.innerHeight >= $("#closedList").height()) {
				let offset = Number($('#closedList').attr('offset')) + 1;
				$('#closedList').attr('offset', offset);
				loadClosedList();
			}
		}
	});
}

function loadClosedList() {
	// お気に入りのみ表示トグル
	$('#favOnlyIcon').off().click((e) => {
		e.preventDefault();
		e.stopPropagation();

		favOnly = !favOnly;
		$('#favOnlyIcon').removeClass(favOnly ? 'off' : 'on').addClass(favOnly ? 'on' : 'off');

		$('#closedList .name').each((i, el) => {
			let name = $(el).text().trim();
			if (favOnly) {
				if (notFavolist.includes(name)) {
					$(el).closest('a').hide();
				}
			} else {
				$(el).closest('a').show();
			}
		});
	});

	let offset = Number($('#closedList').attr('offset'));
	$.get(API_FOLLOW_CLOSED + offset)
	.done(function (res) {
		if (!res.data) return;

		let list = res.data.programs;
		if (0 == offset) {
			$('#closedList').empty();
		}
		if (0 == list.length) {
			if (0 == offset) {
				showListError($('#closedList'), 'フォロー中の番組履歴がありません。');
			}
			return;
		}

		let listHtml = '';
		let thumbnails = [];
		for (let info of list) {
			thumbnails.push(info.listingThumbnail);
			listHtml += buildNicoRow(info, 'closed');
		}
		$('#closedList').append(listHtml);

		applyThumbnailFallback('#closedList img.live', thumbnails, FALLBACK_THUMBNAIL);
		startLiveAnimation('#closedList');
		// ホバーでフィルタアイコン表示は $(function) 内の委譲バインドで処理

		// 絞り込み中なら対象外を隠し、件数が少なければ追加読込
		if (closedFilter) {
			$('#closedList .liveRow .filter:not([userId="' + closedFilter + '"])').closest('a').hide();
			$('.filter path').css('fill', '#03a9f4');
			if (offset < 10 && $("#closedList").height() < 500) {
				let offset = Number($('#closedList').attr('offset')) + 1;
				$('#closedList').attr('offset', offset);
				loadClosedList();
			}
		}
		// フィルタアイコンのクリックで絞り込みの ON/OFF
		$('#closedList .filterIcon').off().on('click', function (e) {
			e.preventDefault();
			e.stopPropagation();

			if (closedFilter) {
				$('#closedList a').show();
				$('.filter path').css('fill', 'black');
				closedFilter = null;
			} else {
				$('#closedList .liveRow .filter:not([userId="' + $(e.currentTarget).closest('.filter').attr('userId') + '"])').closest('a').hide();
				if ($("#closedList").height() < 500) {
					let offset = Number($('#closedList').attr('offset')) + 1;
					$('#closedList').attr('offset', offset);
					loadClosedList();
				}
				$('.filter path').css('fill', '#03a9f4');
				closedFilter = $(e.currentTarget).closest('.filter').attr('userId');
			}
		});
	})
	.fail(function () {
		showListError($('#closedList'), '番組リストの取得に失敗しました。<br>ニコニコにログインしているか確認してください。');
	});
}

// ===== ちくらん一覧（外部サイト: ちくわちゃん） =====

// ちくらん1行分のHTMLを生成（差分更新のキーとして data-live-url / data-rank を付与）
function buildChikuranRow(item) {
	return `
		<a href="${item.liveUrl}" class="liveLink" data-live-url="${item.liveUrl}" data-rank="${item.rank}">
			<div class="row mt-1 mb-1 pt-1 pb-1 pr-1 d-flex align-items-center liveRow">
				<div class="col-1 p-0 text-center" style="min-width: 30px;">
					<span class="rank-num" style="font-weight:bold;">${item.rank}</span>
				</div>
				<div class="thum col-4 p-0" style="z-index:1; min-width:8.5rem; max-width:8.5rem;">
					<img loading="lazy" class="live" src="${item.thumbnail}" style="height:64px; background-color:#eee;">
				</div>
				<div class="col p-0" style="width: calc(100% - 16rem);">
					<div class="row" style="font-size:10px; color:#252525; line-height:2rem; align-items: center;">
						<span class="userLink" url="${item.userLink}">
							<img loading="lazy" class="user" src="${item.userThumbnail}" style="width:1.5rem; margin-right:.3rem; border-radius:100%; line-height:2rem;">
						</span>
						<span style="text-overflow: ellipsis;
									display: block;
									width: calc(100% - 2rem);
									white-space: nowrap;
									overflow-x: hidden;">
							${item.username}
						</span>
					</div>
					<div class="row pr-3 pb-1 prog-title" style="font-weight:bold;">${item.title}</div>
					<div class="row elapsed" style="font-size:10px; color:#252525">${item.elapsed} 経過</div>
				</div>
				<div class="col-1 pl-0 text-center" style="min-width: 80px;">
					<span class="active-count" style="font-weight:bold;">${item.active}</span>
				</div>
			</div>
		</a>
	`;
}

// chikuranList を差分更新する（追加・削除・ランク/タイトル/経過時間/アクティブ数の更新）
function diffUpdateChikuranList(items) {
	const $container = $('#chikuranList');

	// スピナーなど liveLink 以外の要素を除去
	$container.children(':not(a.liveLink)').remove();

	if (items.length === 0) {
		showListError($container, 'ちくらん情報の取得に失敗しました。');
		return;
	}

	const newUrlSet = new Set(items.map(i => i.liveUrl));

	// 新しいリストに存在しない行を削除
	$container.find('a.liveLink').each(function () {
		if (!newUrlSet.has($(this).attr('data-live-url'))) {
			$(this).remove();
		}
	});

	const newUserThumbnails = [];

	for (const item of items) {
		const $existing = $container.find(`a.liveLink[data-live-url="${item.liveUrl}"]`);
		if ($existing.length) {
			// 既存行をその場で更新
			$existing.attr('data-rank', item.rank);
			$existing.find('.rank-num').text(item.rank);
			$existing.find('.prog-title').text(item.title);
			$existing.find('.elapsed').text(`${item.elapsed} 経過`);
			$existing.find('.active-count').text(item.active);
		} else {
			// 新規行: HTMLを追加してフレームバッファを登録
			$container.append(buildChikuranRow(item));
			const img = $container.find(`a.liveLink[data-live-url="${item.liveUrl}"]`).find('img.live')[0];
			if (img && !frameBuffers.has(img)) {
				img.setAttribute('data-original-src', item.thumbnail.replace(/\?t=\d+$/, ''));
				frameBuffers.set(img, { urls: [], idx: 0, lastSize: 0 });
			}
			newUserThumbnails.push(item.userThumbnail);
		}
	}

	// ランク順に DOM を並べ直す
	const $rows = $container.find('a.liveLink').toArray();
	$rows.sort((a, b) => Number($(a).attr('data-rank')) - Number($(b).attr('data-rank')));
	$rows.forEach(el => $container.append(el)); // 既存要素を移動して順序を修正

	// 新規行のユーザーサムネイルフォールバック
	if (newUserThumbnails.length > 0) {
		applyThumbnailFallback('#chikuranList img.user', newUserThumbnails, FALLBACK_USER_ICON);
	}
}

function loadChikuranList() {
	$.get(URL_CHIKURAN)
	.done(function (res) {
		let $page = $(res);
		let $rank = $page.find('#lives_main .rank').parent();

		if (0 == $rank.length) {
			showListError($('#chikuranList'), 'ちくらん情報の取得に失敗しました。');
			return;
		}

		// DOM からアイテム配列を構築してから diffUpdateChikuranList に渡す
		const items = [];
		let rank = 1;
		$rank.each(function () {
			let $info = $(this).closest('.live');
			items.push({
				rank:          rank++,
				liveUrl:       $info.find('.liveurl').attr('href'),
				userThumbnail: $info.find('.image_user img').data('src') ?? $info.find('.image_user img').attr('src'),
				thumbnail:     $info.find('.image_live img').data('src') ?? $info.find('.image_live img').attr('src'),
				username:      $info.find('.title').text(),
				userLink:      $info.find('a.siteicon').attr('href'),
				title:         $info.find('.topic .ti').text(),
				elapsed:       $info.find('.progress').text(),
				active:        $info.find('.points .count').text(),
			});
		});

		diffUpdateChikuranList(items);
		startLiveAnimation('#chikuranList');
	})
	.fail(function () {
		showListError($('#chikuranList'), 'ちくらん情報の取得に失敗しました。');
	});
}

// ===== 日時・経過時間のフォーマット =====

const formatDate = (current_datetime) => {
	let d = new Date(current_datetime);
	let formatted_date = (d.getMonth() + 1) + "/" + d.getDate() + " " + d.getHours() + ":" + padZero(d.getMinutes());
	return formatted_date;
}

function toHms(t) {
	var hms = "";
	var h = t / 3600 | 0;
	var m = t % 3600 / 60 | 0;
	var s = t % 60;

	if (h != 0) {
		hms = h + "時間" + ((m != 0) ? (padZero(m) + "分") : "");
	} else if (m != 0) {
		hms = m + "分";
	} else {
		hms = s + "秒";
	}

	return hms;
}

function padZero(v) {
	if (v < 10) {
		return "0" + v;
	} else {
		return v;
	}
}
