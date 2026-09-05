(function () {
  "use strict";

  const el = (id) => document.getElementById(id);

  const dropzone = el("dropzone");
  const dropzoneEmpty = el("dropzoneEmpty");
  const browseBtn = el("browseBtn");
  const swapBtn = el("swapBtn");
  const previewVideo = el("preview");

  const trimSection = el("trimSection");
  const trimRail = el("trimRail");
  const trimRange = el("trimRange");
  const handleStart = el("handleStart");
  const handleEnd = el("handleEnd");
  const startInput = el("startInput");
  const endInput = el("endInput");
  const selDuration = el("selDuration");
  const totalDuration = el("totalDuration");
  const playSelBtn = el("playSelBtn");

  const widthRow = el("widthRow");
  const fpsRow = el("fpsRow");
  const nameInput = el("nameInput");
  const estFrames = el("estFrames");
  const estSize = el("estSize");

  const generateBtn = el("generateBtn");
  const progressBlock = el("progressBlock");
  const progressStage = el("progressStage");
  const progressFill = el("progressFill");
  const resultBlock = el("resultBlock");
  const resultSize = el("resultSize");
  const resultPath = el("resultPath");
  const revealBtn = el("revealBtn");
  const errorBlock = el("errorBlock");
  const errorMsg = el("errorMsg");

  const statusLeft = el("statusLeft");
  const statusRight = el("statusRight");

  const state = {
    path: null,
    duration: 0,
    start: 0,
    end: 0,
    width: 360,
    fps: 15,
  };

  // ---------------------------------------------------------- boot motion
  window.addEventListener("DOMContentLoaded", () => {
    anime({
      targets: ".mark-block",
      translateY: [-16, 0],
      opacity: [0, 1],
      duration: 480,
      delay: anime.stagger(90),
      easing: "easeOutBack",
    });
    anime({
      targets: ".stage, .controls",
      opacity: [0, 1],
      translateY: [10, 0],
      duration: 420,
      delay: 120,
      easing: "easeOutQuad",
    });
  });

  // -------------------------------------------------------------- button feel
  function pressable(node) {
    node.addEventListener("mousedown", () => {
      anime({ targets: node, translateY: [0, 3], translateX: [0, 3], duration: 90, easing: "easeOutQuad" });
      node.style.boxShadow = "0 0 0 var(--ink)";
    });
    const release = () => {
      anime({ targets: node, translateY: [3, 0], translateX: [3, 0], duration: 160, easing: "easeOutBack" });
      node.style.boxShadow = "";
    };
    node.addEventListener("mouseup", release);
    node.addEventListener("mouseleave", release);
  }
  [generateBtn, browseBtn].forEach(pressable);

  // ------------------------------------------------------------- file load
  async function loadVideo(path) {
    const info = await window.pywebview.api.probe(path);
    state.path = path;
    state.duration = info.duration || 0;
    state.start = 0;
    state.end = Math.min(state.duration, 2.5);

    previewVideo.src = await window.pywebview.api.get_video_url(path);
    previewVideo.classList.remove("hidden");
    dropzoneEmpty.classList.add("hidden");
    swapBtn.classList.remove("hidden");

    totalDuration.textContent = state.duration.toFixed(2) + "s";
    startInput.max = state.duration;
    endInput.max = state.duration;
    startInput.value = state.start.toFixed(1);
    endInput.value = state.end.toFixed(1);

    trimSection.classList.remove("hidden");
    anime({ targets: "#trimSection", opacity: [0, 1], translateY: [8, 0], duration: 320, easing: "easeOutQuad" });

    layoutHandles();
    updateSelection();
    generateBtn.disabled = false;
    statusLeft.textContent = path.split(/[\\/]/).pop() + " · " + info.width + "×" + info.height;
  }

  async function pickFile() {
    const result = await window.pywebview.api.pick_video();
    if (result) loadVideo(result.path);
  }
  browseBtn.addEventListener("click", pickFile);
  swapBtn.addEventListener("click", pickFile);

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    // pywebview exposes the real filesystem path as pywebviewFullPath on
    // dropped File objects; browsers without that patch can't give us one,
    // so we fall back to the native picker.
    const path = file && (file.pywebviewFullPath || file.path);
    if (path) loadVideo(path);
    else pickFile();
  });

  // ------------------------------------------------------------ trim rail
  function railRect() { return trimRail.getBoundingClientRect(); }
  function timeToX(t) {
    if (!state.duration) return 0;
    return (t / state.duration) * railRect().width;
  }
  function xToTime(x) {
    const w = railRect().width || 1;
    const t = (x / w) * state.duration;
    return Math.max(0, Math.min(state.duration, t));
  }

  function layoutHandles() {
    const w = railRect().width;
    handleStart.style.left = (timeToX(state.start) - 7) + "px";
    handleEnd.style.left = (timeToX(state.end) - 7) + "px";
    trimRange.style.left = timeToX(state.start) + "px";
    trimRange.style.width = Math.max(0, timeToX(state.end) - timeToX(state.start)) + "px";
  }

  function updateSelection() {
    selDuration.textContent = (state.end - state.start).toFixed(2) + "s";
    const frames = Math.max(1, Math.round((state.end - state.start) * state.fps));
    estFrames.textContent = frames;
    // rough size heuristic: width-scaled pixel volume per frame, gif ~ lossless-ish
    const w = state.width === "original" ? 480 : state.width;
    const kb = Math.round(frames * w * 0.9 * 0.012);
    estSize.textContent = "~" + kb + " KB";
    startInput.value = state.start.toFixed(1);
    endInput.value = state.end.toFixed(1);
    layoutHandles();
  }

  function dragHandle(handle, isStart) {
    handle.addEventListener("mousedown", (downEvt) => {
      downEvt.preventDefault();
      anime({ targets: handle, scale: [1, 1.25], duration: 120, easing: "easeOutQuad" });

      function onMove(moveEvt) {
        const rect = railRect();
        const x = Math.max(0, Math.min(rect.width, moveEvt.clientX - rect.left));
        let t = xToTime(x);
        if (isStart) {
          state.start = Math.min(t, state.end - 0.1);
          state.start = Math.max(0, state.start);
        } else {
          state.end = Math.max(t, state.start + 0.1);
          state.end = Math.min(state.duration, state.end);
        }
        updateSelection();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        anime({ targets: handle, scale: [1.25, 1], duration: 160, easing: "easeOutBack" });
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  dragHandle(handleStart, true);
  dragHandle(handleEnd, false);

  startInput.addEventListener("change", () => {
    state.start = Math.max(0, Math.min(parseFloat(startInput.value) || 0, state.end - 0.1));
    updateSelection();
  });
  endInput.addEventListener("change", () => {
    state.end = Math.min(state.duration, Math.max(parseFloat(endInput.value) || 0, state.start + 0.1));
    updateSelection();
  });

  playSelBtn.addEventListener("click", () => {
    previewVideo.currentTime = state.start;
    previewVideo.play();
    const stop = () => {
      if (previewVideo.currentTime >= state.end) {
        previewVideo.pause();
        previewVideo.removeEventListener("timeupdate", stop);
      }
    };
    previewVideo.addEventListener("timeupdate", stop);
  });

  window.addEventListener("resize", layoutHandles);

  // ------------------------------------------------------------- chip rows
  function wireChipRow(row, dataAttr, onSelect) {
    row.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      row.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
      btn.classList.add("is-active");
      anime({ targets: btn, scale: [0.9, 1], duration: 200, easing: "easeOutBack" });
      onSelect(btn.dataset[dataAttr]);
    });
  }
  wireChipRow(widthRow, "width", (v) => {
    state.width = v === "original" ? "original" : parseInt(v, 10);
    updateSelection();
  });
  wireChipRow(fpsRow, "fps", (v) => {
    state.fps = parseInt(v, 10);
    updateSelection();
  });

  // --------------------------------------------------------------- events
  window.__gifForgeEvent = function (payload, eventName) {
    if (eventName === "progress") {
      progressBlock.classList.remove("hidden");
      progressStage.textContent =
        payload.stage === "palette" ? "building color palette" :
        payload.stage === "encode" ? "encoding frames" : "finishing up";
      anime({ targets: progressFill, width: payload.pct + "%", duration: 500, easing: "easeOutQuad" });
    } else if (eventName === "complete") {
      finishJob(payload);
    } else if (eventName === "error") {
      failJob(payload);
    }
  };

  function finishJob(payload) {
    progressBlock.classList.add("hidden");
    resultBlock.classList.remove("hidden");
    resultSize.textContent = payload.size_kb + " KB";
    resultPath.textContent = payload.out_path;
    revealBtn.onclick = () => window.pywebview.api.reveal_in_folder(payload.out_path);
    anime({ targets: "#resultBlock", scale: [0.9, 1], opacity: [0, 1], duration: 420, easing: "easeOutElastic(1, .6)" });
    setGenerating(false);
    statusRight.textContent = "done";
  }

  function failJob(payload) {
    progressBlock.classList.add("hidden");
    errorBlock.classList.remove("hidden");
    errorMsg.textContent = payload.message;
    setGenerating(false);
    statusRight.textContent = "error";
  }

  function setGenerating(isGenerating) {
    generateBtn.disabled = isGenerating || !state.path;
    generateBtn.querySelector(".btn-label").textContent = isGenerating ? "forging…" : "generate gif";
  }

  // ------------------------------------------------------------- generate
  generateBtn.addEventListener("click", async () => {
    if (!state.path) return;
    resultBlock.classList.add("hidden");
    errorBlock.classList.add("hidden");

    const suggested = (nameInput.value.trim() || "output") + ".gif";
    const outPath = await window.pywebview.api.pick_save_path(suggested);
    if (!outPath) return;

    setGenerating(true);
    progressBlock.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressStage.textContent = "preparing";
    statusRight.textContent = "working";

    await window.pywebview.api.start_job({
      path: state.path,
      start: state.start,
      end: state.end,
      width: state.width,
      fps: state.fps,
      out_path: outPath,
    });
  });

  updateSelection();
})();
