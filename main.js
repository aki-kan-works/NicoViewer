// NicoViewer 視聴ページ用 content script（jQueryベース）
// プレイヤー内ボタンから「拡張メニュー / ワイプメニュー / キャプチャメニュー」を提供し、
// コメント透過度・音量ブースト・画面反転・コメントワイプ・配信キャプチャ等を行う。
//
// 構成:
//   $(document).ready → プレイヤーDOM生成をポーリングで待ち、init() を実行
//   init()            → 各メニューのUI挿入とイベント登録（下記セクション参照）
//   initWipe()        → ワイプ表示（コメント/ゲーム）の制御
//
// 注意: ニコ生のクラス名は難読化＆動的なため [class^=] / [class*=] の部分一致で参照する。

const debug = false;
let opacity = 1.0; // コメント透過度（0.0〜1.0）。Ctrl+↑/↓ で変更

// 画面反転（左右反転 / 解除）用の transform スタイル
const transformCss1 = "transform: rotateY(180deg);-webkit-transform:rotateY(180deg);-moz-transform:rotateY(180deg);-ms-transform:rotateY(180deg);";
const transformCss2 = "transform: rotateY(0);-webkit-transform:rotateY(0);-moz-transform:rotateY(0);-ms-transform:rotateY(0);";

// 音量ブースト（Web Audio API）用
let audioCtx;
let source;
let gainNode;
let tm_emo;
let className_tooltip;   // プレイヤー内ボタンに付与するニコ生のボタン用クラス名
let classList_menuItem;  // 右クリックメニュー項目用のクラス名
let stream = null;       // 録画中の MediaStream
let videoWidth;          // キャプチャ時の出力解像度
let videoHeight;

$(document).ready(function(){
	// プレイヤーのコメントボタンが現れたら、プレイヤーDOMが揃ったとみなして init()
	var tm_init = setInterval(function(){
		let $backButton = $('[class^="___comment-button___"]');
		if(0 != $backButton.length){
			// className_tooltip = $backButton[0].classList[0];
			className_tooltip = "___original-button___OS_ma";
			init();
			clearInterval(tm_init);
		}
	}, 500);
});

function init(){
	// ===== プレイヤー内ボタンの挿入（ワイプ / 拡張 / キャプチャ） =====
	$('[class^="___addon-controller___"]').prepend(
		`<button id="nicoExtentionWipe" class="${className_tooltip}" style="background-color:transparent;border:none;cursor: pointer;" aria-pressed="false" aria-label="ワイプメニュー">
		<svg style="height:18px; width:18px;" viewBox="0 0 16 16" class="bi bi-pip" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path fill-rule="evenodd" d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-9zM1.5 3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/>
			<path d="M8 8.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-3z"/>
		</svg>
		</button>`);
	$('[class^="___addon-controller___"]').prepend(
		`<button id="nicoExtention" class="${className_tooltip}" style="background-color:transparent;border:none;cursor: pointer;" aria-pressed="false" aria-label="拡張メニュー">
		<img src="${chrome.runtime.getURL('images/niconico.png')}" style="height:18px;width:20px;">
		</button>`);
	$('[class^="___addon-controller___"]').prepend(
		`<button id="nicoExtentionCapture" class="${className_tooltip}" style="background-color:transparent;border:none;cursor: pointer;" aria-pressed="false" aria-label="キャプチャメニュー(β)">
			<svg style="height:18px; width:18px;" fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--!Font Awesome Free v7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc.--><path d="M149.1 64.8L138.7 96 64 96C28.7 96 0 124.7 0 160L0 416c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-256c0-35.3-28.7-64-64-64l-74.7 0-10.4-31.2C356.4 45.2 338.1 32 317.4 32L194.6 32c-20.7 0-39 13.2-45.5 32.8zM256 192a96 96 0 1 1 0 192 96 96 0 1 1 0-192z"/></svg>
		</button>`);
	// ===== 各メニューパネルのHTML挿入（拡張 / ワイプ / キャプチャ） =====
	$('[class^="___setting-popup-control___"]').append(`
		<div id="nicoExtArea" style="" class="___target___ ___setting-panel2___ ___setting-panel-ext___ hide" data-scene="root" id="id-1" data-role="target" data-item-length="5" data-scene-prev="videoQuality">
			<div class="___player-main-setting-menu2___" id="id-2">
				<div class="___content___" data-item-length="5">

					<div class="___video-low-latency-toggle-button-field___ ___toggle-button-field___">
						<div class="___caption___ANSPn ___caption___3R7zH">
							<label class="___label___" >コメント透過度</label>
							<div id="labelCommentOpac" class="___vol-size-control___ ${className_tooltip}" data-isolated="false" aria-label="">
								<input class="___slider1___ ___slider2___ ___range___ ___input___" id="commentOpac" min="0" max="100" step="2" type="range" value="100">
								<div id="commentOpacValue"></div>
							</div>
						</div>
					</div>

					<div class="___video-low-latency-toggle-button-field___ ___toggle-button-field___">
						<div class="___caption___ANSPn ___caption___3R7zH">
							<label class="___label___" >音量ブースト（配信音声のみ）</label>
							<div id="labelVolume" class="___vol-size-control___ ${className_tooltip}" data-isolated="false" aria-label="">
								<!--
								<span class="___slider___3V5j1 ___slider1___ ___slider2___ ___range___ ___input___" data-min="0" data-max="100" data-step="1" data-value="50">
									<span class="___track___ ___slider-track___" aria-hidden="true">
										<span class="___value___gIZxK ___slider-value___ZhQh1" style="margin-right: 74%;"></span>
										<span class="___handle___14PK4 ___slider-handle___GtDrm" style="margin-left: 26%;"></span>
									</span>
								</span>
								-->
								<input class="___slider1___ ___slider2___ ___range___ ___input___" id="haisinVolumeSize" min="0" max="500" step="1" type="range" value="100">
								<div id="volvalue"></div>
							</div>
						</div>
					</div>
					<div class="___video-low-latency-toggle-button-field___ ___toggle-button-field___">
						<div class="___caption___ANSPn ___caption___3R7zH">
							<label class="___label___" for="radio-hide-emotion">ゲーム・ギフト非表示</label>
							<button id="radio-hide-emotion" class="___target-btn1___ ___target-btn2___" type="button" data-toggle-mode="state" aria-pressed="false" data-toggle-state="false"></button>
						</div>
					</div>
					<div class="___video-low-latency-toggle-button-field___ ___toggle-button-field___">
						<div class="___caption___ANSPn ___caption___3R7zH">
							<label class="___label___" for="radio-hanten">画面反転</label>
							<button id="radio-hanten" class="___target-btn1___ ___target-btn2___" type="button" data-toggle-mode="state" aria-pressed="false" data-toggle-state="true"></button>
						</div>
					</div>
					<div class="___video-low-latency-toggle-button-field___ ___toggle-button-field___">
						<div class="___caption___ANSPn ___caption___3R7zH">
							<label class="___label___" for="radio-comment-avoid">人物を避けてコメントを描画</label>
							<button id="radio-comment-avoid" class="___target-btn1___ ___target-btn2___" type="button" data-toggle-mode="state" aria-pressed="false" data-toggle-state="false"></button>
						</div>
					</div>
				</div>
			</div>
		</div>
  	`);

	  $('[class^="___setting-popup-control___"]').append(`
	  <div id="nicoWipeArea" style="" class="___target___ ___setting-panel2___ ___setting-panel-wipe___ hide" data-scene="root" id="id-1" data-role="target" data-item-length="5" data-scene-prev="videoQuality">
		  <div class="___player-main-setting-menu2___" id="id-2">
			  <div class="___content___" data-item-length="5">
			  <!--
			  <div class="___video-low-latency-toggle-button-field___ ___toggle-button-field___">
				  <div class="___caption___ANSPn ___caption___3R7zH">
					  <label class="___label___" for="radio-wipeNicogame">自動ニコゲーモード</label>
					  <button id="radio-wipeNicogame" class="___target-btn1___ ___target-btn2___" type="button" data-toggle-mode="state" aria-pressed="false" data-toggle-state="true"></button>
				  </div>
			  </div>
			  -->
			  <div class="___video-low-latency-toggle-button-field___ ___toggle-button-field___">
				<div class="___caption___ANSPn ___caption___3R7zH">
					<label class="___label___" for="radio-wipeComment">コメントワイプ表示</label>
					<button id="radio-wipeComment" class="___target-btn1___ ___target-btn2___" type="button" data-toggle-mode="state" aria-pressed="false" data-toggle-state="true"></button>
				</div>
			</div>

				  <div class="___video-low-latency-toggle-button-field___ ___toggle-button-field___">
				  <div class="___caption___ANSPn ___caption___3R7zH">
					  <label class="___label___" for="radio-wipeGame">ゲームワイプ表示</label>
					  <button id="radio-wipeGame" class="___target-btn1___ ___target-btn2___" type="button" data-toggle-mode="state" aria-pressed="false" data-toggle-state="true"></button>
				  </div>
			  </div>
		  </div>
	  </div>
	`);

	$('body').append(`
		<div id="nicoCaptureArea" style="height:35px; width:120px; left:10px; top:300px; z-index:9999;" class="___target___ ___setting-panel2___ ___setting-panel-capture___ hide" data-scene="root" id="id-1" data-role="target" data-item-length="5" data-scene-prev="videoQuality" data-browser-fullscreen=ignore>
			<div id="nicoCaptureAreaClose" style="color:white;top:-1px;right:5px;height:18px; position:absolute; display:none;">
				<svg id="Layer_1" style="height:13px; enable-background:new 0 0 128 128;" version="1.1" viewBox="0 0 128 128" xml:space="preserve" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><circle style="fill:red;" class="st0" cx="64" cy="64" r="64"/><path style="fill:white;" class="st1" d="M100.3,90.4L73.9,64l26.3-26.4c0.4-0.4,0.4-1,0-1.4l-8.5-8.5c-0.4-0.4-1-0.4-1.4,0L64,54.1L37.7,27.8  c-0.4-0.4-1-0.4-1.4,0l-8.5,8.5c-0.4,0.4-0.4,1,0,1.4L54,64L27.7,90.3c-0.4,0.4-0.4,1,0,1.4l8.5,8.5c0.4,0.4,1.1,0.4,1.4,0L64,73.9  l26.3,26.3c0.4,0.4,1.1,0.4,1.5,0.1l8.5-8.5C100.7,91.4,100.7,90.8,100.3,90.4z"/></svg>
			</div>
			<div class="___player-main-setting-menu2___" id="id-2">
				<div class="___content___" style="display:inline; height:28px; margin-top: 4px;" data-item-length="1">
					<div id="captureVideo" style="margin-left:4px;cursor:pointer; display: inline">
						<svg xml:space="preserve" viewBox="0 0 100 100" y="0" x="0" xmlns="http://www.w3.org/2000/svg" id="圖層_1" version="1.1" width="200px" height="200px" xmlns:xlink="http://www.w3.org/1999/xlink" style="width:30px;height:auto;background-size:initial;background-repeat-y:initial;background-repeat-x:initial;background-position-y:initial;background-position-x:initial;background-origin:initial;background-image:initial;background-color:transparent;background-clip:initial;background-attachment:initial;animation-play-state:paused" ><g class="ldl-scale" style="transform-origin:50% 50%;transform:rotate(0deg) scale(0.8, 0.8);animation-play-state:paused" ><circle stroke="#333" stroke-width="8" fill="#fff" stroke-miterlimit="10" r="37" cy="50" cx="50" style="stroke:rgb(51, 51, 51);fill:rgb(255, 255, 255);animation-play-state:paused" ></circle>
						<circle fill="#e15b64" r="21" cy="50" cx="50" style="fill:rgb(225, 91, 100);animation-play-state:paused" ></circle>
						<metadata xmlns:d="https://loading.io/stock/" style="animation-play-state:paused" ><d:name style="animation-play-state:paused" >record</d:name>
						
						
						<d:tags style="animation-play-state:paused" >record,copy,log,save,keep,clone,player</d:tags>
						
						
						<d:license style="animation-play-state:paused" >by</d:license>
						
						
						<d:slug style="animation-play-state:paused" >gti4zn</d:slug></metadata></g><!-- generated by https://loading.io/ --></svg>
					</div>
					<div id="capturePic" style="margin-left:12px; margin-top:6px; position:absolute; display: inline">
						<svg style="height:18px; width:18px; cursor:pointer;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Pro 6.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2022 Fonticons, Inc. -->
							<path style="fill:white;" d="M447.1 32h-384C28.64 32-.0091 60.65-.0091 96v320c0 35.35 28.65 64 63.1 64h384c35.35 0 64-28.65 64-64V96C511.1 60.65 483.3 32 447.1 32zM111.1 96c26.51 0 48 21.49 48 48S138.5 192 111.1 192s-48-21.49-48-48S85.48 96 111.1 96zM446.1 407.6C443.3 412.8 437.9 416 432 416H82.01c-6.021 0-11.53-3.379-14.26-8.75c-2.73-5.367-2.215-11.81 1.334-16.68l70-96C142.1 290.4 146.9 288 152 288s9.916 2.441 12.93 6.574l32.46 44.51l93.3-139.1C293.7 194.7 298.7 192 304 192s10.35 2.672 13.31 7.125l128 192C448.6 396 448.9 402.3 446.1 407.6z"/></svg>
					</div>
					<div id="capturePicGame" style="margin-left:46px; margin-top:6px; position:absolute; display: none">
						<svg style="height:18px; width:18px; cursor:pointer;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Pro 6.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2022 Fonticons, Inc. -->
							<path style="fill:white;" d="M447.1 32h-384C28.64 32-.0091 60.65-.0091 96v320c0 35.35 28.65 64 63.1 64h384c35.35 0 64-28.65 64-64V96C511.1 60.65 483.3 32 447.1 32zM111.1 96c26.51 0 48 21.49 48 48S138.5 192 111.1 192s-48-21.49-48-48S85.48 96 111.1 96zM446.1 407.6C443.3 412.8 437.9 416 432 416H82.01c-6.021 0-11.53-3.379-14.26-8.75c-2.73-5.367-2.215-11.81 1.334-16.68l70-96C142.1 290.4 146.9 288 152 288s9.916 2.441 12.93 6.574l32.46 44.51l93.3-139.1C293.7 194.7 298.7 192 304 192s10.35 2.672 13.31 7.125l128 192C448.6 396 448.9 402.3 446.1 407.6z"/></svg>
					</div>
					<div id="capturePicList" style="margin-left:46px; margin-top:6px; position:absolute; display: none;">
						<svg style="height:18px; width:18px; cursor:pointer;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Pro 6.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2022 Fonticons, Inc. -->
							<path style="fill:white;" d="M447.1 32h-384C28.64 32-.0091 60.65-.0091 96v320c0 35.35 28.65 64 63.1 64h384c35.35 0 64-28.65 64-64V96C511.1 60.65 483.3 32 447.1 32zM111.1 96c26.51 0 48 21.49 48 48S138.5 192 111.1 192s-48-21.49-48-48S85.48 96 111.1 96zM446.1 407.6C443.3 412.8 437.9 416 432 416H82.01c-6.021 0-11.53-3.379-14.26-8.75c-2.73-5.367-2.215-11.81 1.334-16.68l70-96C142.1 290.4 146.9 288 152 288s9.916 2.441 12.93 6.574l32.46 44.51l93.3-139.1C293.7 194.7 298.7 192 304 192s10.35 2.672 13.31 7.125l128 192C448.6 396 448.9 402.3 446.1 407.6z"/></svg>
					</div>
			</div>
		</div>
	`);
	draggable($('#nicoCaptureArea').get(0)); // キャプチャパネルはドラッグで移動可能

	// ===== イベント登録 =====

	// --- 拡張メニュー（開閉・ホバー） ---
	$('#nicoExtention').on('mouseenter', function(){
		$(this).find('img').prop('src', chrome.runtime.getURL('images/niconico3.png'))
	});
	$('#nicoExtention').on('mouseleave', function(){
		$(this).find('img').prop('src', chrome.runtime.getURL('images/niconico.png'))
	});

	$('#nicoExtention').on('click', function(){
		$('#nicoWipeArea').removeClass('show').addClass('hide');
		$('#nicoCaptureArea').removeClass('show').addClass('hide');
		// if(isChecked($('#nicoExtention').get())){
		if($('#nicoExtArea').hasClass('show')){
			// $(this).attr('aria-pressed', 'false');
			$('#nicoExtArea').removeClass('show').addClass('hide');
		}else{
			// $(this).attr('aria-pressed', 'true');
			$('#nicoExtArea').removeClass('hide').addClass('show');
		}

		return false;
	});
	$('#nicoExtentionWipe').on('mouseenter', function(){
		$(this).find('svg path').css('color', '#1f7cff');
	});
	$('#nicoExtentionWipe').on('mouseleave', function(){
		$(this).find('svg path').css('color', 'white');
	});

	// --- キャプチャメニュー（開閉・表示位置） ---
	$('#nicoExtentionCapture').on('click', function(e){
		$('#nicoExtArea').removeClass('show').addClass('hide');
		$('#nicoWipeArea').removeClass('show').addClass('hide');
		// if(isChecked($('#nicoExtention').get())){
		if($('#nicoCaptureArea').hasClass('show')){
			// $(this).attr('aria-pressed', 'false');
			$('#nicoCaptureArea').removeClass('show').addClass('hide');
		}else{
			$('#nicoCaptureArea').css('left', e.clientX - 40);
			$('#nicoCaptureArea').css('top', e.clientY - 80);
			
			if(isFullScreen()){
				$('#nicoCaptureArea').css('right','12.5rem');
			}else{
				$('#nicoCaptureArea').css('right','10.5rem');
			}
			// $(this).attr('aria-pressed', 'true');
			$('#nicoCaptureArea').removeClass('hide').addClass('show');
		}

		return false;
	});
	
	// --- 画像キャプチャ ---
	$('#capturePic svg,#capturePicGame svg').on('mousedown', function(){
		let $icon = $(this);
		$icon.css('height', '16px');
		$icon.css('margin-top', '2px');
		// $icon.css('height', '16px');
	});
	$('#capturePic svg,#capturePicGame svg').on('mouseup mouseleave', function(){
		let $icon = $(this);
		$icon.css('height', '18px');
		$icon.css('margin-top', '0px');
	});

	let video = $('[class*="___video-layer___"] video').get(0);
	let ratio = video.offsetHeight / video.offsetWidth;
	videoWidth = 1920;
	videoHeight = videoWidth * ratio;

	let downloading = false;
	$('#capturePic svg').on('mouseup', async function(e){
		// e.stopPropagation();
		// setTimeout(function(){
				
			if(downloading){
				return false;
			}

			downloading = true;
			$(this).find('path').css('fill','gray');

			let imgData = await captureToPng(
				[
					'[class*="___video-layer___"] video',
					// '#comment-layer-container canvas',
					// '#akashic-gameview canvas'
				]
			);
			// let imgDataCom = caputure('#comment-layer-container canvas', imgData);
			let streamId = location.href.match(/\/(lv[\d]+)/);
			streamId = streamId ? streamId[1] : '';
			let title = $('[class*="___program-title___"] span').text();
			let time = $('[class*="___time-score___"] [class*="___value___"]').text();

			chrome.runtime.sendMessage({
				method: "download",
				data: imgData,
				filename: `${streamId}_${title}_${time}.png`
			}, function(){
			});
			
			$(this).find('path').css('fill','white');
			downloading = false;
		// },0);

		// return false;
	});

	$('#capturePicGame svg').on('mouseup', async function(e){
		$('video').hide();
		$('[class*="___announcement-renderer___"],#nicoCaptureArea').hide();
		$('canvas:not(#akashic-gameview canvas:last)').hide();
		$('[data-layer-name="telopLayer"]').hide();
		$('#akashic-gameview canvas:last').show();
	
		setTimeout(function(){
			chrome.runtime.sendMessage({
				method: "capture",
				// data: imgData,
				// filename: `${title}_${time}.png`
			}, async function(url){
				console.log(url);
				
				$('body').append('<canvas id="gameCaptureCanvas" src="" style="display:none;" data-browser-fullscreen=ignore>');
				// $('body').append('<canvas id="sumCanvas" src="" style="display:none;" data-browser-fullscreen=ignore>');
				
				var $canvas = $('#gameCaptureCanvas');

				// let game = $('#akashic-gameview iframe').get(0);
				let game = $('#akashic-gameview canvas:last').get(0);
				if(!game){
					game = $('#akashic-gameview iframe').get(0);
				}
				$canvas.attr('width', game.offsetWidth);
				$canvas.attr('height', game.offsetHeight);
				// $canvas[0].getContext('2d').drawImage(url, game.offsetWidth, game.offsetHeight);
				let pos = game.getBoundingClientRect();
				console.log($('#akashic-gameview').offset());
				
				Jimp.read(url).then(function (lenna) {
					lenna
						.scale(0.8)
						.crop(pos.x, pos.y, pos.width, pos.height)
						.scale(1)
						.getBase64(Jimp.MIME_PNG, function (err, src) {
							var img = document.createElement("img");
							img.setAttribute("src", src);
							document.body.appendChild(img);
						});
				}).catch(function (err) {
					console.error(err);
				});

				$('video').show();
				$('[class*="___announcement-renderer___"],#nicoCaptureArea').show();
				$('canvas:not(#akashic-gameview canvas:last)').show();
				$('[data-layer-name="telopLayer"]').show();
				$('#akashic-gameview canvas:last').show();
			});
		}, 500);
	});

	$('#capturePicList svg').on('mousedown', function(){
		let $icon = $(this);
		$icon.css('height', '16px');
		$icon.css('margin-top', '2px');
	});
	$('#capturePicList svg').on('mouseup mouseleave', function(){
		let $icon = $(this);
		$icon.css('height', '18px');
		$icon.css('margin-top', '0px');
	});
	$('#capturePicList svg').on('mouseup', function(){
		$('video').hide();
		$('canvas:not(#akashic-gameview canvas:last)').hide();
		$('[data-layer-name="telopLayer"]').hide();

		setTimeout(function(){
			chrome.runtime.sendMessage({
				method: "capture",
				// data: imgData,
				// filename: `${title}_${time}.png`
			}, function(){
				$('video').show();
				$('canvas:not(#akashic-gameview canvas:last)').show();
				$('[data-layer-name="telopLayer"]').show();
			});
		}, 500);
		
	});

	// --- 動画キャプチャ ---
	$('#captureVideo svg').on('mousedown', function(){
		let $icon = $(this);
		$icon.css('height', '28px');
		$icon.css('margin-top', '2px');
		// $icon.css('height', '16px');
	});
	$('#captureVideo svg').on('mouseup mouseleave', function(){
		let $icon = $(this);
		$icon.css('height', '30px');
		$icon.css('margin-top', '0px');
	});
	$('#comment-layer-container>div').prepend('<div id="recording-div" class="recording-div"><button id="recording-icon" class="recording-icon"/></div>');
		
	let obs_videoChange = new MutationObserver(obj => {
		if('false' == $(obj[0].target).attr('data-toggle-state')){
			if($('#nicoExtentionCapture').hasClass('recording')){
				// alert();
				$('#captureVideo svg').mouseup();
				showMessage('動画の状態が変更されたため、録画を停止しました。');
			}

			// source.disconnect();
			// gainNode = audioCtx.createGain();
			// source.connect(gainNode);
			// gainNode.connect(audioCtx.destination);
			// // gainNode = null;
			// $('#haisinVolumeSize').change();
		}
	});
	try{
		obs_videoChange.observe(document.querySelector('[class*="___play-button___"]') , {
			attributes: true,
			attributeFilter: ['data-toggle-state']
		});
	}catch(e){
		console.log(e);
	}
	$('#captureVideo svg').on('mouseup', function(){
		if($('#nicoExtentionCapture').hasClass('recording')){
			stop(stream);
			$('.recording-icon').hide();
			$('#nicoExtentionCapture').removeClass('recording');
			// $('#nicoExtentionCapture').attr('aria-label', `キャプチャメニュー(β)`);
		}else{
			$(this).find('svg path').css('color', 'red');
			$('body').append('<video id="recVideo" src="" style="position:absolute; top: 100px; left:10px; height: 100px; width: 150px; z-index:99999;">');
			$('body').append('<a id="recDownload" class="button" style="display:none;">download</a>');

			stream = $('video').get(0).captureStream();
			startRecording(stream)
			.then (recordedChunks => {
				let recDl = $('#recDownload').get(0);
				let recVideo = $('#recVideo').get(0);
				let recordedBlob = new Blob(recordedChunks, { type: "video/mp4" });
				recVideo.src = URL.createObjectURL(recordedBlob);
				recDl.href = recVideo.src;

				let streamId = location.href.match(/\/(lv[\d]+)/);
				streamId = streamId ? streamId[1] : '';
				let title = $('[class*="___program-title___"] span').text();
				recDl.download = `${streamId}_${title}.mp4`;
				recDl.click();

				$('#recVideo').remove();
				$('#recDownload').remove();
			})
			.then(() => $('#nicoExtentionCapture').attr('aria-label', `キャプチャメニュー(β)`));
			
			$('#recording-icon').show();
			$('#recording-icon').css('display' ,'block!important');
			$('#nicoExtentionCapture').addClass('recording');
			$('#nicoExtentionCapture').attr('aria-label', `size:0 MB`);
		}

		// return false;
	});

	// --- ワイプメニュー（開閉） ---
	$('#nicoExtentionWipe').on('click', function(){
		$('#nicoExtArea').removeClass('show').addClass('hide');
		$('#nicoCaptureArea').removeClass('show').addClass('hide');
		if($('#nicoWipeArea').hasClass('show')){
			// $(this).attr('aria-pressed', 'false');
			$('#nicoWipeArea').removeClass('show').addClass('hide');
		}else{
			// $(this).attr('aria-pressed', 'true');
			$('#nicoWipeArea').removeClass('hide').addClass('show');
		}

		return false;
	});
	// --- メニュー外クリック等でパネルを閉じる ---
	$('[class^="___setting-button___"],[aria-label="設定"]').click(function(){
		$('#nicoExtention,#nicoExtentionWipe').attr('aria-pressed', 'false');
		$('#nicoExtArea,#nicoWipeArea').removeClass('show').addClass('hide');
	});
	$('body').click(function(e){
		if("recDownload" != e.target.id){
			$('#nicoExtention,#nicoExtentionWipe').attr('aria-pressed', 'false');
			$('#nicoExtArea,#nicoWipeArea').removeClass('show').addClass('hide');
		}
	});
	$('#nicoExtArea,#nicoWipeArea,#nicoCaptureArea').click(function(){
		return false;
	});

	initWipe();

	// --- 拡張メニュー: コメント透過度スライダー ---
	$('#labelCommentOpac').attr('aria-label', `透過度:${$('#commentOpac').val()}％`);
	$('#commentOpac').on('input change', function(){
		$('[data-layer-name="commentLayer"]').css('opacity',$(this).val() / 100);
		$('#labelCommentOpac').attr('aria-label', `透過度:${$(this).val()}％`);

		return false;
	});

	// --- 拡張メニュー: 音量ブースト（配信音声のみ。Web Audio の GainNode で増幅） ---
	$('#labelVolume').attr('aria-label', `ブースト:${$('#haisinVolumeSize').val()}％`);
	$('#haisinVolumeSize').on('input change', function(){
		if(!gainNode){
			audioCtx = new AudioContext();
			source = audioCtx.createMediaElementSource(document.querySelector('video'));
		
			// create a gain node
			gainNode = audioCtx.createGain();
			gainNode.gain.value = 1; // double the volume
			source.connect(gainNode);
		
			// connect the gain node to an output destination
			gainNode.connect(audioCtx.destination);
			$('#labelVolume').attr('aria-label', `ブースト:${$('#haisinVolumeSize').val()}％`);
		}
		// connect the gain node to an output destination
		// gainNode.connect(audioCtx.destination);
		gainNode.gain.value = $(this).val() / 100;
        // var elemv = document.getElementById("volvalue");
        // elemv.innerHTML = gainNode.gain.value.toFixed(2);
		$('#labelVolume').attr('aria-label', `ブースト:${$(this).val()}％`);

		return false;
	});

	// --- スライダーツールチップ: ドラッグ中のみ表示、離したら消す ---
	// mouseup はスライダー外で離した場合も document で確実に受け取る
	$('#commentOpac, #haisinVolumeSize').on('mousedown touchstart', function(){
		var $label = $(this).closest('.___vol-size-control___');
		$label.addClass('dragging');
		$(document).one('mouseup touchend', function(){
			$label.removeClass('dragging');
		});
	});

	// --- 拡張メニュー: 画面反転（配信映像を左右反転） ---
	$('#radio-hanten').click(function(){
		if(isChecked(this)){
			$(this).attr('aria-pressed', 'false');
			$('video')[0].style.cssText += transformCss2;
		}else{
			$(this).attr('aria-pressed', 'true');
			$('video')[0].style.cssText += transformCss1;
		}

		return false;
	});

	// --- 拡張メニュー: コメント人物避け（人物の上だけコメントを透過。処理本体は personMask.js） ---
	$('#radio-comment-avoid').click(function(){
		if(isChecked(this)){
			$(this).attr('aria-pressed', 'false');
			if(window.NicoPersonMask) NicoPersonMask.stop();
		}else{
			$(this).attr('aria-pressed', 'true');
			// ワイプ表示中なら強制解除（人物避けとワイプは併用しない）
			if(isChecked($('#radio-wipeComment'))) $('#radio-wipeComment').click();
			if(isChecked($('#radio-wipeGame'))) $('#radio-wipeGame').click();
			if(window.NicoPersonMask){
				// 準備中/ON/失敗の通知は personMask.js 側のトースト(notify)で表示する
				NicoPersonMask.start().then(function(ok){
					// モデル読込/初期化に失敗したらトグルを戻す
					if(!ok) $('#radio-comment-avoid').attr('aria-pressed', 'false');
				});
			}
		}

		return false;
	});

	// --- コメント描画拡張: Ctrl+↑/↓ でコメント透過度を5%単位で変更 ---
	$(window).keydown(function(e){
		if(event.ctrlKey){
			// ↑
			if(e.keyCode === 38){
				opacity += (opacity < 1) ? 0.05 : 0;
				$('[data-layer-name="commentLayer"]').css('opacity',opacity);
				return false;
			}
			// ↓
			if(e.keyCode === 40){
				opacity -= (opacity > 0) ? 0.05 : 0;
				$('[data-layer-name="commentLayer"]').css('opacity',opacity);
				return false;
			}
		}
	});

	// --- 拡張メニュー: ゲーム・ギフト（エモーション）非表示 ---
	//   エモーションレイヤ(#akashic-gameview>div)の表示/非表示を手動トグルで切り替える。
	//   「未表示時に自動で隠す」自動判定は obs_emo ともども修正待ちのため無効化中。
	function hideEmotion(){
		if(!isChecked($('#radio-hide-emotion'))){
			$('#akashic-gameview>div').css('visibility','visible');
		}else{
			$('#akashic-gameview>div').css('visibility','hidden');
		}

		// if(!isChecked($('#radio-hide-emotion'))){
		// 	clearInterval(tm_emo);
		// 	tm_emo = null;
		// 	$('#akashic-gameview>div').css('visibility','visible');
		// }else{
		// 	// チェックあり
		// 	// 起動中アイテムあり
		// 	if(0 < $('div[class*="___launch-item-area___"]').find('[class*="___item___"]').length){
		// 		clearInterval(tm_emo);
		// 		tm_emo = null;
		// 		$('#akashic-gameview>div').css('visibility','visible');
		// 		// log('cansel hide');
		// 	}else{
		// 		// 起動中アイテムなし
		// 		// ギフトテロップあり
		// 		if($('[class*="___message-scrolling-area___"]>[class*="___belt___"]>span:not(.emoChecked)').text().includes('を贈りました')){
		// 			clearInterval(tm_emo);
		// 			tm_emo = null;
		// 			$('#akashic-gameview>div').css('visibility','visible');

		// 			// ギフトのテロップか未チェックのテロップをチェック
		// 			$('[class*="___message-scrolling-area___"]>[class*="___belt___"]>span:not(.emoChecked)').each(function(){
		// 				// ギフトテロップがある場合
		// 				if($(this).text().includes('を贈りました')){
		// 					$(this).addClass('emoChecked');
		// 					$('#akashic-gameview>div').css('visibility','visible');
		// 					clearInterval(tm_emo);
		// 					tm_emo = setTimeout(function(){
		// 						clearInterval(tm_emo);
		// 						if(0 < $('div[class*="___launch-item-area___"]').find('[class*="___item___"]').length){
		// 							clearInterval(tm_emo);
		// 							$('#akashic-gameview>div').css('visibility','visible');
		// 						}else{
		// 							$('#akashic-gameview>div').css('visibility','hidden');
		// 							// log('hide1');
		// 						}
		// 						tm_emo = null;
		// 						//log('hide');
		// 					},15000);
		// 					log('reserve hide1');
		// 				}
		// 			});
		// 		}else{
		// 			// ギフトテロップなし
		// 			// 起動中アイテムなし
		// 			if(0 == $('div[class*="___launch-item-area___"]').find('[class*="___item___"]').length){
		// 				if(!tm_emo){
		// 					tm_emo = setTimeout(function(){
		// 						if(0 < $('div[class*="___launch-item-area___"]').find('[class*="___item___"]').length){
		// 							clearInterval(tm_emo);
		// 							$('#akashic-gameview>div').css('visibility','visible');
		// 						}else{
		// 							$('#akashic-gameview>div').css('visibility','hidden');
		// 							log('hide2');
		// 						}
		// 						tm_emo = null;
		// 						//log('hide');
		// 					},15000);
		// 					log('reserve hide2');
		// 				}
		// 			}else{
		// 				clearInterval(tm_emo);
		// 				tm_emo = null;
		// 				$('#akashic-gameview>div').css('visibility','visible');
		// 			}
		// 		}
		// 	}
		// }
	}
	// const obs_emo = new MutationObserver(records => {
	// 	hideEmotion();
	// });

	// setInterval(function(){
	// 	hideEmotion();
	// }, 1000);

	// ↓エモーション自動判定（obs_emo）の修正待ちに伴い無効化。
	//   obs_emo の定義は上のとおりコメントアウト中のため、再開時はセットで戻すこと。
	//   （有効なままだと obs_emo 未定義で実行時エラーになるためコメントアウト）
	// let tm_setObs = setInterval(function() {
	// 	if(2 == document.querySelectorAll('div[class*="___telop-layer___"],div[class*="___launch-item-area___"]').length){
	// 		clearInterval(tm_setObs);
	//
	// 		obs_emo.observe(document.querySelector('div[class*="___telop-layer___"]') , {
	// 			childList: true,
	// 			subtree: true
	// 		});
	// 		obs_emo.observe(document.querySelector('div[class*="___launch-item-area___"]') , {
	// 			childList: true,
	// 			subtree: true
	// 		});
	// 	}
	// }, 1000);
	$('#radio-hide-emotion').click(function(){
		hideEmotion();
		if(isChecked(this)){
			$(this).attr('aria-pressed', 'false');
			// obs_emo.disconnect();
			// $('#akashic-gameview>div').css('visibility','visible');
			// clearInterval(tm_emo);
		}else{
			$(this).attr('aria-pressed', 'true');
			// obs_emo.observe(document.querySelector('[class^="___comment-data-grid___"]') , {
			// obs_emo.observe(document.querySelector('div[class*="___telop-layer___"],div[class*="___launch-item-area___"]') , {
			// 	childList: true,
			// 	subtree: true
			// });
		}

		return false;
	});

	// ↓184/名札プレースホルダ表示機能（修正待ち）。下の iyayoTm ともども休止中。
	//   observer は iyayoTm からのみ起動されるため、再開時はセットで戻すこと。
	// const observer = new MutationObserver(records => {
	// 	let iyayo = isChecked($('[class^="___anonymous-comment-post-toggle-button-field___"]>button'));
	// 	$('[class^="___comment-text-box___"]').attr('placeholder', iyayo ? '名札でコメントする' : '184でコメントする');
	// 	// if(iyayo){
	// 	// 	$('[class^="___comment-text-box___"]').removeClass('___comment-text-box-nama___');
	// 	// }else{
	// 	// 	$('[class^="___comment-text-box___"]').addClass('___comment-text-box-nama___');
	// 	// }
	// });
	// let iyayoTm = setInterval(function(){
	// 	// try{
	// 		let x = window.scrollX;
	// 		let y = window.scrollY;
			
	// 		new Promise((resolved) => {
	// 			// $('[class^="___command-tool___"]').css('opacity', '0');
	// 			if($('[class^="___comment-text-box___"]').length != 0){
	// 				clearInterval(iyayoTm);
	// 				// $('[class^="___command-tool___"]').css('opacity', '0');
	// 				$('[name="command"]').focus();
	// 				let iyayoObj = document.querySelector('[class^="___anonymous-comment-post-toggle-button-field___"]>button');
	// 				$('[class^="___comment-text-box___"]').focus();
	// 				$('[class^="___comment-text-box___"]').blur();
	// 				window.scrollTo(x,y);


	// 				// $('[class^="___command-palette___"]').removeClass('___command-palette___25yre');
	// 				// $('[class^="___command-palette___"]').addClass('___command-palette-show___25yre');
	// 				let iyayo = isChecked($('[class^="___anonymous-comment-post-toggle-button-field___"]>button'));
	// 				$('[class^="___comment-text-box___"]').attr('placeholder', iyayo ? '名札でコメントする' : '184でコメントする');
	// 				// if(iyayo){
	// 				// 	$('[class^="___comment-text-box___"]').removeClass('___comment-text-box-nama___');
	// 				// }else{
	// 				// 	$('[class^="___comment-text-box___"]').addClass('___comment-text-box-nama___');
	// 				// }
	// 				observer.observe(iyayoObj , {
	// 					attributes: true
	// 				});
	// 			}
	// 			resolved();
	// 		})
	// 		.then(() => {
	// 			requestAnimationFrame(() => {
	// 				setTimeout(() => {
	// 					$('[class^="___comment-text-box___"]').focus();
	// 					$('[class^="___comment-text-box___"]').blur();
	// 					window.scrollTo(x,y);
	// 					$('[class^="___command-tool___"]').css('opacity', '1');
	// 				}, 5000);
	// 			});
	// 		});
	// 		// setTimeout(function(){
	// 		// }, 1000);
	// 	// }catch(e){}
	// }, 100);

	// URLを開く
	const obs_url = new MutationObserver(records => {
		let $comments = $('[class^="___comment-data-grid___"] [class^="___table-row___"]');
		$comments.off('contextmenu');
		$comments.on('contextmenu', function(){
			targetComment = this;
		});

		let $menu = $('[class^="___comment-context-menu___"]');
		if(0 < $menu.length){
			log('obsurl');
			if(0 == $('li[data-item-name="openUrl"]').length){
				if(!classList_menuItem){
					let $menuItem = $('[class*="___menu-item___"]');
					if(0 != $menuItem.length){
						classList_menuItem = $menuItem[0].classList;
					}
				}

				$menu.find('ul[class^="___comment-menu___"]').append(
					`<li data-item-name="openUrl">
						<button id="openUrl" class="${classList_menuItem.toString()}" type="button">URLを開く</button>
					</li>`
				);
				$('#openUrl').click(function(){
					let comment = $(targetComment).find('[class^="___comment-text___"]').text();
					$menu.hide();

					let m = comment.match(/ttps?:\/\/[\w!\?\/\+\-_~=;\.,\*&@#\$%\(\)'\[\]]+/g);
					if(m){
						window.open('h' + m[0], '_blank');
					}
				});
			}
		}
	});
	
	var tm_comment = setInterval(function(){
		if(document.querySelector('[class^="___contents-area___"] [class^="___comment-data-grid___"]')){
			clearInterval(tm_comment);
			obs_url.observe(document.querySelector('[class^="___contents-area___"] [class^="___comment-data-grid___"]') , {
				childList: true,
				subtree: true
			});
		
			const obs_url2 = new MutationObserver(records => {
				if(0 < $('[class^="___contents-area___"] [class^="___comment-data-grid___"]').length){
					obs_url.observe(document.querySelector('[class^="___comment-data-grid___"]') , {
						childList: true,
						subtree: true
					});
				}
			});
			
			obs_url2.observe(document.querySelector('[class^="___contents-area___"]') , {
				childList: true,
				subtree: true
			});
		}
	}, 1000);

	// ===== 広告パネルの非表示 =====
	var tm_ad = setInterval(() => {
		if(document.querySelector('[class^="___player-ad-panel___"]')){
			$('[class^="___player-ad-panel___"]').hide();
			clearInterval(tm_ad);
		}
	}, 1000);

	var tm_ad2 = setInterval(() => {
		if(document.querySelector('[class^="___ad-sticky-video___"]')){
			$('[class^="___ad-sticky-video___"]').hide();
			clearInterval(tm_ad2);
		}
	}, 1000);
}

function initWipe(){
	let $commentLayer,$commentLayerBack,$commentCanvas;
	let obs_wipeComment;
	let isWipeComment = false;
	$('#radio-wipeComment').click(function(){
		wipeComment(false);
		// ワイプ表示をONにしたら「人物を避けてコメントを描画」を自動OFF（縮小表示中は無意味なため）
		if(isChecked(this) && window.NicoPersonMask && NicoPersonMask.isRunning()){
			NicoPersonMask.stop();
			$('#radio-comment-avoid').attr('aria-pressed', 'false');
			NicoPersonMask.notify('ワイプ表示中のため「人物を避けてコメントを描画」をOFFにしました。', 4000);
		}
		if(!obs_wipeComment){
			obs_wipeComment = new MutationObserver(records => {
				$commentLayer.css('transition','all 0ms 0s ease');
				wipeComment(true);
				$commentLayer.css('transition','all 300ms 0s ease');
			});
			obs_wipeComment.observe(document.querySelector('[data-layer-name="commentLayer"]') , {
				attributes: true,
				attributeFilter: ['style']
			});
		}

		return false;
	});
	function wipeComment(isAdjust){
		if(null == $commentLayer){
			$commentLayer = $('#comment-layer-container');
			$commentLayer.css('transition','all 300ms 0s ease');
			$commentLayer.parent().prepend('<div id="comment-layer-container-background" style="background-color:white; opacity:0.1; position:absolute; display:none;"></div>');
		}
		if(null == $commentLayerBack) $commentLayerBack = $('#comment-layer-container-background');
		if(null == $commentCanvas) $commentCanvas = $commentLayer.find('canvas');
		$commentLayer.css('position','absolute');
		$radioBtn = $('#radio-wipeComment');
		if((!isAdjust && isChecked($radioBtn)) || (isAdjust && !isChecked($radioBtn))){
			if(!isAdjust) $($radioBtn).attr('aria-pressed', 'false');
			$commentLayer.css('transform','scale(1)');
			$commentLayer.css('right',  0);
			$commentLayer.css('bottom', 0);
			if(!isWipeGame) $commentLayerBack.hide();
			isWipeComment = false;
		}else{
			if(!isAdjust) $($radioBtn).attr('aria-pressed', 'true');
			$commentLayer.css('transform','scale(0.3)');
			$commentLayer.css('right',  -1 * $commentLayer.get(0).offsetWidth / 3);
			$commentLayer.css('bottom', -1 * $commentLayer.get(0).offsetHeight / 3);
			$commentLayerBack.show();
			$commentLayerBack.css('transform','scale(0.3)');
			$commentLayerBack.css('right',  -1 * $commentLayer.get(0).offsetWidth / 3);
			$commentLayerBack.css('bottom', -1 * $commentLayer.get(0).offsetHeight / 3);
			isWipeComment = true;
		}
	}

	let $gameLayer,$gameLayerBack,$videoLayer;
	let obs_wipeGame;
	let isWipeGame = false;
	$('#radio-wipeGame').click(function(){
		wipeGame(false);
		// ワイプ表示をONにしたら「人物を避けてコメントを描画」を自動OFF（縮小表示中は無意味なため）
		if(isChecked(this) && window.NicoPersonMask && NicoPersonMask.isRunning()){
			NicoPersonMask.stop();
			$('#radio-comment-avoid').attr('aria-pressed', 'false');
			NicoPersonMask.notify('ワイプ表示中のため「人物を避けてコメントを描画」をOFFにしました。', 4000);
		}
		if(!obs_wipeGame){
			obs_wipeGame = new MutationObserver(records => {
				$gameLayer.css('transition','all 0ms 0s ease');
				wipeGame(true);
				$gameLayer.css('transition','all 300ms 0s ease');
			});
			obs_wipeGame.observe(document.querySelector('[data-layer-name="commentLayer"]') , {
				attributes: true,
				attributeFilter: ['style']
			});
		}

		return false;
	});
	function wipeGame(isAdjust, {isNicogame = false, gaming = false} = {}){
		if(null == $videoLayer){
			$videoLayer = $('[class*="___video-layer___"]>div');
			$videoLayer.css('transition','all 300ms 0s ease');
		}
		if(null == $commentLayer){
			$commentLayer = $('#comment-layer-container');
			$commentLayer.css('transition','all 300ms 0s ease');
			$commentLayer.parent().prepend('<div id="comment-layer-container-background" style="background-color:white; opacity:0.1; position:absolute; display:none;"></div>');
		}
		if(null == $commentLayerBack) $commentLayerBack = $('#comment-layer-container-background');
		if(null == $gameLayer){
			$gameLayer = $('#akashic-gameview');
			$gameLayer.css('transition','all 300ms 0s ease');
			// $('#akashic-gameview>div').prepend('<div id="akashic-gameview-background" style="background-color:white; opacity:0.2; position:absolute; height:100%; width:100%; display:none;"></div>');
			$gameLayer.css('position','absolute');
		}
		// if(null == $gameLayerBack) $gameLayerBack = $('#akashic-gameview-background');

		$radioBtn = $('#radio-wipeGame');
		$radioBtnNicogame = $('#radio-wipeNicogame');
		if(isNicogame){
			if(((!isAdjust && isChecked($radioBtnNicogame)) || (isAdjust && !isChecked($radioBtnNicogame))) && !gaming){
				if(!isAdjust){
					// $($radioBtnNicogame).attr('aria-pressed', 'false');
				}
				$gameLayer.css('transform','scale(1)');
				$gameLayer.css('right',  0);
				$gameLayer.css('bottom', 0);
				$videoLayer.css('transform','scale(1)');
				$videoLayer.css('left',  0);
				$videoLayer.css('top', 0);
				// if(!isWipeComment) $commentLayerBack.hide();
			}else{
				if(!isAdjust){
					// $($radioBtnNicogame).attr('aria-pressed', 'true');
				}
				$gameLayer.css('transform','scale(0.8)');
				$gameLayer.css('right',  -1 * $commentLayer.get(0).offsetWidth * 0.1);
				$gameLayer.css('bottom', -1 * $commentLayer.get(0).offsetHeight * 0.1);
				$videoLayer.css('transform','scale(0.3)');
				$videoLayer.css('left',  -1 * $commentLayer.get(0).offsetWidth * 0.35);
				$videoLayer.css('top', -1 * $commentLayer.get(0).offsetHeight * 0.35);
			}
		}else{
			if((!isAdjust && isChecked($radioBtn)) || (isAdjust && !isChecked($radioBtn))){
				if(!isAdjust){
					$($radioBtn).attr('aria-pressed', 'false');
				}
				$gameLayer.css('transform','scale(1)');
				$gameLayer.css('right',  0);
				$gameLayer.css('bottom', 0);
				if(!isWipeComment) $commentLayerBack.hide();
				isWipeGame = false;
			}else{
				if(!isAdjust){
					$($radioBtn).attr('aria-pressed', 'true');
				}
				$gameLayer.css('transform','scale(0.3)');
				$gameLayer.css('right',  -1 * $commentLayer.get(0).offsetWidth / 3);
				$gameLayer.css('bottom', -1 * $commentLayer.get(0).offsetHeight / 3);
				$commentLayerBack.show();
				$commentLayerBack.css('transform','scale(0.3)');
				$commentLayerBack.css('right',  -1 * $commentLayer.get(0).offsetWidth / 3);
				$commentLayerBack.css('bottom', -1 * $commentLayer.get(0).offsetHeight / 3);
				isWipeGame = true;
			}
		}

		// $gameLayer.css('transition','all 300ms 0s ease');
		// $videoLayer.css('transition','all 300ms 0s ease');
	}
	
	let $header = $('[class*="___player-display-header___"]');
	let obs_headerComment = new MutationObserver(records => {
		if(isWipeComment && 0 < $('[class*="___player-display-header___"][data-header-mode="normal"]').length){
			if(0 < $header.find('div').length){
				$('#comment-layer-container').parent().css('margin-top', `-${document.querySelector('[class*="___player-display-header___"]>div').offsetHeight}px`);
			}else{
				$('#comment-layer-container').parent().css('margin-top', '0');
			}
		}else{
			$('#comment-layer-container').parent().css('margin-top', '0');
		}
	});
	obs_headerComment.observe(document.querySelector('[class*="___player-display-header___"]') , {
		childList: true
	});

	$('#radio-wipeNicogame').click(function(){
		if(isChecked(this)){
			$(this).attr('aria-pressed', 'false');
		}else{
			$(this).attr('aria-pressed', 'true');
		}

		// wipeGame(false, {isNicogame: true, gaming: false});
		// checkNicogaming();
		
		if(isChecked($('#radio-wipeNicogame'))){
			checkNicogaming();
			obs_checkNicogaming.observe(document.querySelector('div[class*="___lock-item-area___"]') , {
				childList: true,
				subtree: true
			});
		}else{
			obs_checkNicogaming.disconnect();
		}

		return false;
	});
	
	function checkNicogaming(){
		if(isChecked($('#radio-wipeNicogame'))){
			// チェックあり
			// 起動中アイテムあり
			if(0 < $('div[class*="___launch-item-area___"]').find('[class*="___item___"]').length){
				wipeGame(false, {isNicogame: true, gaming: true});
			}else{
				wipeGame(false, {isNicogame: true, gaming: false});
			}
		}
	}
	const obs_checkNicogaming = new MutationObserver(records => {
		checkNicogaming();
	});


}

function showMessage(msg, showsec){
	var $msgArea = $('[class*="___snack-bar___"]');
	$msgArea.find('p').text(msg);
	$msgArea.attr('aria-hidden', 'false');

	if(showsec){
		setTimeout(function(){
			// $msgArea.find('p').text('追っかけ再生ではゲームやアンケートなどの操作はできません。');
			$msgArea.attr('aria-hidden', 'true');
		}, showsec);
	}
}


function isChecked(obj){
	return $(obj).attr('aria-pressed') == 'true';
}

function isFullScreen(){
	return $('[class*="___fullscreen-button___"]').attr('data-toggle-state') == 'true';
}

function log(str){
	if(debug) console.log(str);
}