// Minimal play-button-only overlay for HTML5 videos.
//
// Why: Browsers don't expose a reliable way to show *only* the native play button.
// This script hides native controls and adds an accessible overlay button.
//
// Scope: Only affects <video class="minimal-controls"> elements.

(function () {
	"use strict";

	function setOverlayState(video, button) {
		var isPlaying = !video.paused && !video.ended;
		// When playing, hide the overlay to keep the video unobstructed.
		button.style.opacity = isPlaying ? "0" : "1";
		button.style.pointerEvents = isPlaying ? "none" : "auto";
		button.setAttribute("aria-label", isPlaying ? "Pause video" : "Play video");
		button.classList.toggle("is-playing", isPlaying);
	}

	function ensureWrapper(video) {
		// If already wrapped, do nothing.
		if (video.parentElement && video.parentElement.classList.contains("video-minimal-wrapper")) {
			return video.parentElement;
		}

		var wrapper = document.createElement("div");
		wrapper.className = "video-minimal-wrapper";

		// Preserve layout by placing wrapper where video was.
		video.parentNode.insertBefore(wrapper, video);
		wrapper.appendChild(video);

		return wrapper;
	}

	function createButton() {
		var btn = document.createElement("button");
		btn.type = "button";
		btn.className = "video-minimal-play";
		btn.setAttribute("aria-label", "Play video");
		btn.innerHTML = '<span class="video-minimal-play-icon" aria-hidden="true"></span>';
		return btn;
	}

	function setupVideo(video) {
		// Remove native controls (Firefox/Chrome ignore attempts to hide subcontrols).
		video.controls = false;
		video.removeAttribute("controls");
		video.setAttribute("controlslist", "nodownload noplaybackrate noremoteplayback");
		video.setAttribute("disablepictureinpicture", "");

		// Make sure taps/clicks play inline on mobile where possible.
		video.setAttribute("playsinline", "");

		var wrapper = ensureWrapper(video);
		var btn = createButton();
		wrapper.appendChild(btn);

		function togglePlay() {
			if (video.paused || video.ended) {
				var p = video.play();
				// Ignore promise rejection (autoplay policy etc.), the overlay remains.
				if (p && typeof p.catch === "function") {
					p.catch(function () {});
				}
			} else {
				video.pause();
			}
		}

		btn.addEventListener("click", function (e) {
			e.preventDefault();
			e.stopPropagation();
			togglePlay();
		});

		// Optional: allow clicking the video itself to toggle.
		video.addEventListener("click", function () {
			togglePlay();
		});

		// Keep button state in sync.
		["play", "pause", "ended", "loadeddata"].forEach(function (ev) {
			video.addEventListener(ev, function () {
				setOverlayState(video, btn);
			});
		});

		setOverlayState(video, btn);
	}

	function init() {
		var videos = document.querySelectorAll("video.minimal-controls");
		videos.forEach(setupVideo);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
