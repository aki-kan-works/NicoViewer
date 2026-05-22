// 配信映像のキャプチャ関連処理（main.js から呼び出される）
// - startRecording / stop : 動画録画（MediaRecorder）
// - captureToPng          : 指定要素を canvas に描画して PNG の data URL を取得
// - draggable             : 要素をドラッグで移動可能にする

// MediaRecorder で録画を開始する。停止後に録画データ（Blobの配列）を返す Promise を返す。
function startRecording(stream) {
	let recorder = new MediaRecorder(stream);
	let data = [];

	// 5秒ごとにデータが届くので、累計サイズをボタンの aria-label に表示
	recorder.ondataavailable = (event) => {
		data.push(event.data);
		let size = data.map((d) => d.size).reduce((a, s) => a + s) / 1000 / 1000;
		$('#nicoExtentionCapture').attr('aria-label', `size:${size.toFixed(1)} MB`);
	};

	try {
		recorder.start(5000);
	} catch (e) {
		console.log(e.message);
		return;
	}

	let stopped = new Promise((resolve, reject) => {
		recorder.onstop = resolve;
		recorder.onerror = (event) => reject(event.name);
	});

	return stopped.then(() => data);
}

// ストリームの全トラックを停止する（録画停止）
function stop(stream) {
	stream.getTracks().forEach((track) => track.stop());
}

// 要素をマウスドラッグで移動できるようにする
function draggable(target) {
	let x = 0;
	let y = 0;
	target.onmousedown = function (e) {
		x = e.offsetX;
		y = e.offsetY;
		document.onmousemove = mouseMove;
		return false;
	};
	document.onmouseup = function () {
		document.onmousemove = null;
	};
	function mouseMove(e) {
		var event = e ? e : window.event;
		target.style.top = event.pageY - y - 1 + 'px';
		target.style.left = event.pageX - x + 'px';
	}
}

// 指定セレクタの要素（video/canvas等）を順に canvas へ描画し、PNG の data URL を返す
async function captureToPng(capObjSelectors) {
	$('body').append('<canvas id="captureCanvas" src="" style="display:none;" data-browser-fullscreen=ignore>');

	var $canvas = $('#captureCanvas');
	$canvas.attr('width', videoWidth);
	$canvas.attr('height', videoHeight);

	for (let sel of capObjSelectors) {
		let capObj = document.querySelector(sel);
		if (!capObj) {
			continue;
		}
		$canvas[0].getContext('2d').drawImage(capObj, 0, 0, videoWidth, videoHeight);
	}

	let data = $canvas[0].toDataURL('image/png');
	$canvas.remove();
	return data;
}
