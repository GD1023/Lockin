/* ===========================================================
   LOCK IN — App logic
   =========================================================== */

(function () {
  "use strict";

  const STORAGE_KEY = "lockin_state_v2";
  const POMODORO_CYCLES = 4;
  const RING_RADIUS = 164;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

  /* ---------------- Default state ---------------- */

  function defaultState() {
    return {
      session: {
        name: "Calculus — Chapter 7",
        mode: "Deep Work",
        notes: "",
        notesOpen: false,
        focusedSeconds: 0,
        tasksCompletedThisSession: 0,
      },
      tasks: [
        { id: uid(), name: "Finish problem set", time: 35, priority: "high", order: 0 },
        { id: uid(), name: "Review lecture notes", time: 20, priority: "medium", order: 1 },
        { id: uid(), name: "Complete practice problems", time: 30, priority: "low", order: 2 },
      ],
      sortMode: "manual",
      timer: {
        durationMinutes: 50,
        customMinutes: 45,
        structure: "single", // single | pomodoro | custom
        breakMinutes: 10,
        cycles: 3,
        planIndex: 0,
        remainingSeconds: 50 * 60,
        running: false,
        completed: false,
        lastTick: null,
      },
      history: [], // { date: 'YYYY-MM-DD', focusedSeconds, tasksCompleted, timestamp }
      focusMode: false,
    };
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  /* ---------------- Load / Save ---------------- */

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      // shallow-merge to survive schema additions
      return {
        ...base,
        ...parsed,
        session: { ...base.session, ...(parsed.session || {}) },
        timer: { ...base.timer, ...(parsed.timer || {}), running: false, lastTick: null },
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : base.tasks,
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* storage unavailable — fail silently */
    }
  }

  /* ---------------- DOM refs ---------------- */

  const $ = (id) => document.getElementById(id);

  const appEl = $("app");
  const sessionNameInput = $("sessionNameInput");
  const modeSelect = $("modeSelect");
  const statFocused = $("statFocused");
  const statTasksDone = $("statTasksDone");
  const statCompletion = $("statCompletion");
  const sessionProgressFill = $("sessionProgressFill");
  const notesToggle = $("notesToggle");
  const notesBody = $("notesBody");
  const sessionNotes = $("sessionNotes");

  const taskInput = $("taskInput");
  const taskList = $("taskList");
  const taskEmpty = $("taskEmpty");
  const tasksRemaining = $("tasksRemaining");
  const sortSelect = $("sortSelect");

  const timerDisplay = $("timerDisplay");
  const timerSubtext = $("timerSubtext");
  const ringProgress = $("ringProgress");
  const timerRingWrap = document.querySelector(".timer-ring-wrap");
  const startPauseBtn = $("startPauseBtn");
  const startPauseLabel = $("startPauseLabel");
  const resetBtn = $("resetBtn");
  const settingsBtn = $("settingsBtn");
  const cycleTrack = $("cycleTrack");
  const completeOverlay = $("completeOverlay");
  const completeFocused = $("completeFocused");
  const completeTasks = $("completeTasks");
  const completePct = $("completePct");
  const startAnotherBtn = $("startAnotherBtn");
  const viewSessionBtn = $("viewSessionBtn");

  const phaseIndicator = $("phaseIndicator");
  const phaseLabel = $("phaseLabel");

  const focusModeBtn = $("focusModeBtn");
  const historyBtn = $("historyBtn");

  const settingsModalBackdrop = $("settingsModalBackdrop");
  const settingsModalClose = $("settingsModalClose");
  const settingsCancelBtn = $("settingsCancelBtn");
  const settingsApplyBtn = $("settingsApplyBtn");
  const durationSelect = $("durationSelect");
  const customDurationRow = $("customDurationRow");
  const customDurationInput = $("customDurationInput");
  const structureSelect = $("structureSelect");
  const pomodoroOptions = $("pomodoroOptions");
  const customCyclesOptions = $("customCyclesOptions");
  const breakSelect = $("breakSelect");
  const cyclesMinus = $("cyclesMinus");
  const cyclesPlus = $("cyclesPlus");
  const cyclesCount = $("cyclesCount");
  const cyclePreview = $("cyclePreview");

  const historyModalBackdrop = $("historyModalBackdrop");
  const historyModalClose = $("historyModalClose");
  const todayFocused = $("todayFocused");
  const todaySessions = $("todaySessions");
  const todayTasks = $("todayTasks");
  const weekFocused = $("weekFocused");
  const weekSessions = $("weekSessions");
  const weekChart = $("weekChart");

  const toastEl = $("toast");

  let priorityMenuEl = null;

  /* ---------------- Utility ---------------- */

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatMMSS(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${pad2(m)}:${pad2(sec)}`;
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 2200);
  }

  /* ---------------- Timer plan ---------------- */

  function resolvedDuration() {
    return state.timer.durationMinutes === "custom"
      ? Number(state.timer.customMinutes) || 45
      : Number(state.timer.durationMinutes);
  }

  function buildPlan() {
    const { structure, breakMinutes, cycles } = state.timer;
    const dur = resolvedDuration();
    if (structure === "single") return [{ type: "focus", minutes: dur }];
    const n = structure === "pomodoro" ? POMODORO_CYCLES : Math.max(1, Number(cycles) || 1);
    const plan = [];
    for (let i = 0; i < n; i++) {
      plan.push({ type: "focus", minutes: dur });
      if (i < n - 1) plan.push({ type: "break", minutes: breakMinutes });
    }
    return plan;
  }

  let currentPlan = buildPlan();

  function currentSegment() {
    return currentPlan[Math.min(state.timer.planIndex, currentPlan.length - 1)];
  }

  function segmentTotalSeconds(seg) {
    return seg.minutes * 60;
  }

  /* ---------------- Rendering: Timer ---------------- */

  function initRing() {
    ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  }

  function renderTimer() {
    const seg = currentSegment();
    const total = segmentTotalSeconds(seg);
    const remaining = state.timer.remainingSeconds;
    timerDisplay.textContent = formatMMSS(remaining);
    timerDisplay.classList.toggle("is-running", state.timer.running);

    const isBreak = seg.type === "break";
    timerRingWrap.classList.toggle("is-break", isBreak);
    phaseIndicator.classList.toggle("is-break", isBreak);
    phaseLabel.textContent = isBreak ? "BREAK" : "FOCUS";

    const modeName = state.session.mode || "Deep Work";
    const sessName = state.session.name || "Session";
    timerSubtext.textContent = isBreak ? "Break · Recharge" : `${modeName} · ${sessName}`;

    const elapsed = total - remaining;
    const fraction = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0;
    const offset = RING_CIRCUMFERENCE * (1 - fraction);
    ringProgress.style.strokeDashoffset = String(offset);

    startPauseLabel.textContent = state.timer.running ? "PAUSE" : "START";
    startPauseBtn.querySelector(".icon-play").style.display = state.timer.running ? "none" : "";
    startPauseBtn.querySelector(".icon-pause").style.display = state.timer.running ? "" : "none";
    startPauseBtn.classList.toggle("is-active", state.timer.running);

    renderCycleTrack();
  }

  function renderCycleTrack() {
    cycleTrack.innerHTML = "";
    if (currentPlan.length <= 1) {
      cycleTrack.style.display = "none";
      return;
    }
    cycleTrack.style.display = "flex";
    currentPlan.forEach((seg, i) => {
      if (i > 0) {
        const arrow = document.createElement("span");
        arrow.className = "cycle-arrow";
        arrow.textContent = "→";
        cycleTrack.appendChild(arrow);
      }
      const step = document.createElement("div");
      step.className = "cycle-step";
      if (i === state.timer.planIndex) step.classList.add("active");
      else if (i < state.timer.planIndex) step.classList.add("done");
      step.innerHTML = `<span class="cycle-dot"></span><span class="cycle-label">${seg.minutes} ${seg.type === "focus" ? "FOCUS" : "BREAK"}</span>`;
      cycleTrack.appendChild(step);
    });
  }

  /* ---------------- Timer engine ---------------- */

  let intervalId = null;

  function startTimer() {
    if (state.timer.completed) return;
    if (state.timer.running) return;
    state.timer.running = true;
    state.timer.lastTick = Date.now();
    intervalId = setInterval(tick, 1000);
    renderTimer();
    saveState();
  }

  function pauseTimer() {
    state.timer.running = false;
    clearInterval(intervalId);
    intervalId = null;
    renderTimer();
    saveState();
  }

  function toggleStartPause() {
    if (state.timer.running) pauseTimer();
    else startTimer();
  }

  function resetTimer() {
    pauseTimer();
    currentPlan = buildPlan();
    state.timer.planIndex = 0;
    state.timer.remainingSeconds = segmentTotalSeconds(currentPlan[0]);
    state.timer.completed = false;
    completeOverlay.classList.remove("visible");
    renderTimer();
    saveState();
  }

  function tick() {
    const seg = currentSegment();
    state.timer.remainingSeconds -= 1;

    if (seg.type === "focus") {
      state.session.focusedSeconds += 1;
    }

    if (state.timer.remainingSeconds <= 0) {
      advanceSegment();
    } else {
      renderTimer();
      // persist periodically, not every second, to limit writes
      if (state.timer.remainingSeconds % 5 === 0) saveState();
    }
  }

  function advanceSegment() {
    const isLast = state.timer.planIndex >= currentPlan.length - 1;
    if (isLast) {
      finishSession();
      return;
    }
    state.timer.planIndex += 1;
    const seg = currentSegment();
    state.timer.remainingSeconds = segmentTotalSeconds(seg);
    renderTimer();
    saveState();
    showToast(seg.type === "break" ? "Break time" : "Back to focus");
  }

  function finishSession() {
    pauseTimer();
    state.timer.completed = true;
    state.timer.remainingSeconds = 0;

    const completedCount = state.session.tasksCompletedThisSession;
    const remainingCount = state.tasks.length;
    const total = completedCount + remainingCount;
    const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;

    completeFocused.textContent = formatMMSS(state.session.focusedSeconds);
    completeTasks.textContent = `${completedCount}/${total}`;
    completePct.textContent = `${pct}%`;

    state.history.push({
      date: todayISO(),
      focusedSeconds: state.session.focusedSeconds,
      tasksCompleted: completedCount,
      timestamp: Date.now(),
    });

    renderTimer();
    saveState();

    requestAnimationFrame(() => {
      completeOverlay.classList.add("visible");
    });
  }

  /* ---------------- Session stats ---------------- */

  function renderSessionStats() {
    statFocused.textContent = formatMMSS(state.session.focusedSeconds);
    statTasksDone.textContent = String(state.session.tasksCompletedThisSession);

    const completed = state.session.tasksCompletedThisSession;
    const remaining = state.tasks.length;
    const total = completed + remaining;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    statCompletion.textContent = `${pct}%`;
    sessionProgressFill.style.width = `${pct}%`;
  }

  /* ---------------- Tasks ---------------- */

  function getSortedTasks() {
    const list = [...state.tasks];
    if (state.sortMode === "priority") {
      list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order);
    } else if (state.sortMode === "time") {
      list.sort((a, b) => {
        const at = a.time == null ? Infinity : a.time;
        const bt = b.time == null ? Infinity : b.time;
        return at - bt || a.order - b.order;
      });
    } else {
      list.sort((a, b) => a.order - b.order);
    }
    return list;
  }

  function renderTasks() {
    const sorted = getSortedTasks();
    const draggable = state.sortMode === "manual";

    taskList.innerHTML = "";
    sorted.forEach((task) => {
      taskList.appendChild(buildTaskRow(task, draggable));
    });

    taskEmpty.classList.toggle("visible", state.tasks.length === 0);
    tasksRemaining.textContent = `${state.tasks.length} remaining`;
    renderSessionStats();
  }

  function buildTaskRow(task, draggable) {
    const li = document.createElement("li");
    li.className = "task-item";
    li.dataset.id = task.id;
    li.draggable = draggable;

    const handle = document.createElement("span");
    handle.className = "drag-handle-row";
    handle.title = draggable ? "Drag to reorder" : "";
    for (let i = 0; i < 6; i++) handle.appendChild(document.createElement("span"));

    const check = document.createElement("button");
    check.className = "task-check";
    check.setAttribute("aria-label", "Complete task");
    check.addEventListener("click", () => completeTask(task.id, li));

    const dot = document.createElement("span");
    dot.className = `task-priority-dot ${task.priority}`;
    dot.title = "Click to change priority";
    dot.addEventListener("click", (e) => openPriorityMenu(e, task.id));

    const name = document.createElement("input");
    name.className = "task-name";
    name.value = task.name;
    name.spellcheck = false;
    name.addEventListener("change", () => {
      updateTask(task.id, { name: name.value.trim() || "Untitled task" });
      renderTasks();
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
    });

    const time = document.createElement("input");
    time.className = "task-time mono";
    time.value = task.time != null ? `${task.time}m` : "";
    time.placeholder = "--";
    time.addEventListener("focus", () => {
      time.value = task.time != null ? String(task.time) : "";
      time.select();
    });
    time.addEventListener("blur", () => {
      const n = parseInt(time.value, 10);
      const val = Number.isFinite(n) && n > 0 ? Math.min(n, 999) : null;
      updateTask(task.id, { time: val });
      renderTasks();
    });
    time.addEventListener("keydown", (e) => {
      if (e.key === "Enter") time.blur();
    });

    const del = document.createElement("button");
    del.className = "task-delete";
    del.setAttribute("aria-label", "Delete task");
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    del.addEventListener("click", () => deleteTask(task.id, li));

    li.appendChild(handle);
    li.appendChild(check);
    li.appendChild(dot);
    li.appendChild(name);
    li.appendChild(time);
    li.appendChild(del);

    if (draggable) attachDragHandlers(li);

    return li;
  }

  function addTask(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order), -1);
    state.tasks.push({
      id: uid(),
      name: trimmed,
      time: null,
      priority: "medium",
      order: maxOrder + 1,
    });
    saveState();
    renderTasks();
  }

  function updateTask(id, patch) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    saveState();
    renderSessionStats();
  }

  function deleteTask(id, li) {
    removeRowAnimated(li, () => {
      state.tasks = state.tasks.filter((t) => t.id !== id);
      saveState();
      renderTasks();
    });
  }

  function completeTask(id, li) {
    removeRowAnimated(li, () => {
      state.tasks = state.tasks.filter((t) => t.id !== id);
      state.session.tasksCompletedThisSession += 1;
      saveState();
      renderTasks();
    });
  }

  function removeRowAnimated(li, after) {
    li.classList.add("removing");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      after();
    };
    li.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 320); // fallback safety
  }

  /* ---------------- Drag and drop reordering ---------------- */

  let dragId = null;

  function attachDragHandlers(li) {
    li.addEventListener("dragstart", (e) => {
      dragId = li.dataset.id;
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      dragId = null;
      persistOrderFromDOM();
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragId || dragId === li.dataset.id) return;
      const rect = li.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      const draggingEl = taskList.querySelector(`[data-id="${dragId}"]`);
      if (!draggingEl) return;
      if (before) {
        taskList.insertBefore(draggingEl, li);
      } else {
        taskList.insertBefore(draggingEl, li.nextSibling);
      }
    });
  }

  function persistOrderFromDOM() {
    const ids = [...taskList.querySelectorAll(".task-item")].map((el) => el.dataset.id);
    ids.forEach((id, idx) => {
      const t = state.tasks.find((x) => x.id === id);
      if (t) t.order = idx;
    });
    saveState();
  }

  /* ---------------- Priority menu ---------------- */

  function ensurePriorityMenu() {
    if (priorityMenuEl) return priorityMenuEl;
    const menu = document.createElement("div");
    menu.className = "priority-menu";
    menu.innerHTML = `
      <button class="priority-menu-item" data-p="high"><span class="dot high"></span>High</button>
      <button class="priority-menu-item" data-p="medium"><span class="dot medium"></span>Medium</button>
      <button class="priority-menu-item" data-p="low"><span class="dot low"></span>Low</button>
    `;
    document.body.appendChild(menu);
    priorityMenuEl = menu;
    return menu;
  }

  let priorityMenuTaskId = null;

  function openPriorityMenu(e, taskId) {
    e.stopPropagation();
    const menu = ensurePriorityMenu();
    priorityMenuTaskId = taskId;
    const rect = e.target.getBoundingClientRect();
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 160)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.classList.add("open");
  }

  function closePriorityMenu() {
    if (priorityMenuEl) priorityMenuEl.classList.remove("open");
    priorityMenuTaskId = null;
  }

  document.addEventListener("click", (e) => {
    if (priorityMenuEl && priorityMenuEl.classList.contains("open") && !priorityMenuEl.contains(e.target)) {
      closePriorityMenu();
    }
  });

  document.addEventListener("click", (e) => {
    const item = e.target.closest(".priority-menu-item");
    if (!item || !priorityMenuTaskId) return;
    updateTask(priorityMenuTaskId, { priority: item.dataset.p });
    closePriorityMenu();
    renderTasks();
  });

  /* ---------------- Session panel wiring ---------------- */

  sessionNameInput.value = state.session.name;
  sessionNameInput.addEventListener("input", () => {
    state.session.name = sessionNameInput.value;
    saveState();
    renderTimer();
  });

  modeSelect.querySelectorAll(".mode-chip").forEach((chip) => {
    if (chip.dataset.mode === state.session.mode) chip.classList.add("active");
    else chip.classList.remove("active");
    chip.addEventListener("click", () => {
      modeSelect.querySelectorAll(".mode-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.session.mode = chip.dataset.mode;
      saveState();
      renderTimer();
    });
  });

  notesToggle.addEventListener("click", () => {
    state.session.notesOpen = !state.session.notesOpen;
    applyNotesState();
    saveState();
  });

  function applyNotesState() {
    notesToggle.setAttribute("aria-expanded", String(state.session.notesOpen));
    notesBody.classList.toggle("open", state.session.notesOpen);
  }

  sessionNotes.value = state.session.notes;
  sessionNotes.addEventListener("input", () => {
    state.session.notes = sessionNotes.value;
    saveState();
  });

  /* ---------------- Tasks panel wiring ---------------- */

  taskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      addTask(taskInput.value);
      taskInput.value = "";
    }
  });

  sortSelect.value = state.sortMode;
  sortSelect.addEventListener("change", () => {
    state.sortMode = sortSelect.value;
    saveState();
    renderTasks();
  });

  /* ---------------- Timer controls wiring ---------------- */

  startPauseBtn.addEventListener("click", toggleStartPause);
  resetBtn.addEventListener("click", resetTimer);

  startAnotherBtn.addEventListener("click", () => {
    completeOverlay.classList.remove("visible");
    state.session.focusedSeconds = 0;
    state.session.tasksCompletedThisSession = 0;
    resetTimer();
    saveState();
    renderSessionStats();
    showToast("New session started");
  });

  viewSessionBtn.addEventListener("click", () => {
    completeOverlay.classList.remove("visible");
  });

  /* ---------------- Settings modal ---------------- */

  function openSettingsModal() {
    // sync UI to state
    durationSelect.querySelectorAll(".duration-chip").forEach((chip) => {
      const val = chip.dataset.mins;
      const match = val === "custom" ? state.timer.durationMinutes === "custom" : Number(val) === state.timer.durationMinutes;
      chip.classList.toggle("active", match);
    });
    customDurationRow.style.display = state.timer.durationMinutes === "custom" ? "flex" : "none";
    customDurationInput.value = state.timer.customMinutes;

    structureSelect.querySelectorAll(".structure-chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.structure === state.timer.structure);
    });
    pomodoroOptions.style.display = state.timer.structure === "pomodoro" ? "block" : "none";
    customCyclesOptions.style.display = state.timer.structure === "custom" ? "block" : "none";

    breakSelect.querySelectorAll(".duration-chip").forEach((chip) => {
      chip.classList.toggle("active", Number(chip.dataset.mins) === state.timer.breakMinutes);
    });

    cyclesCount.textContent = state.timer.cycles;
    updateCyclePreview();

    settingsModalBackdrop.classList.add("open");
  }

  function closeSettingsModal() {
    settingsModalBackdrop.classList.remove("open");
  }

  settingsBtn.addEventListener("click", openSettingsModal);
  settingsModalClose.addEventListener("click", closeSettingsModal);
  settingsCancelBtn.addEventListener("click", closeSettingsModal);
  settingsModalBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsModalBackdrop) closeSettingsModal();
  });

  let pendingDuration = state.timer.durationMinutes;
  let pendingStructure = state.timer.structure;
  let pendingBreak = state.timer.breakMinutes;
  let pendingCycles = state.timer.cycles;
  let pendingCustomMinutes = state.timer.customMinutes;

  durationSelect.querySelectorAll(".duration-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      durationSelect.querySelectorAll(".duration-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      pendingDuration = chip.dataset.mins === "custom" ? "custom" : Number(chip.dataset.mins);
      customDurationRow.style.display = pendingDuration === "custom" ? "flex" : "none";
      updateCyclePreview();
    });
  });

  customDurationInput.addEventListener("input", () => {
    pendingCustomMinutes = Number(customDurationInput.value) || 45;
    updateCyclePreview();
  });

  structureSelect.querySelectorAll(".structure-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      structureSelect.querySelectorAll(".structure-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      pendingStructure = chip.dataset.structure;
      pomodoroOptions.style.display = pendingStructure === "pomodoro" ? "block" : "none";
      customCyclesOptions.style.display = pendingStructure === "custom" ? "block" : "none";
      updateCyclePreview();
    });
  });

  breakSelect.querySelectorAll(".duration-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      breakSelect.querySelectorAll(".duration-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      pendingBreak = Number(chip.dataset.mins);
      updateCyclePreview();
    });
  });

  cyclesMinus.addEventListener("click", () => {
    pendingCycles = Math.max(1, pendingCycles - 1);
    cyclesCount.textContent = pendingCycles;
    updateCyclePreview();
  });
  cyclesPlus.addEventListener("click", () => {
    pendingCycles = Math.min(8, pendingCycles + 1);
    cyclesCount.textContent = pendingCycles;
    updateCyclePreview();
  });

  function updateCyclePreview() {
    const dur = pendingDuration === "custom" ? pendingCustomMinutes : pendingDuration;
    if (pendingStructure === "single") {
      cyclePreview.textContent = `${dur} MIN FOCUS`;
      return;
    }
    const n = pendingStructure === "pomodoro" ? POMODORO_CYCLES : pendingCycles;
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push(`${dur} MIN FOCUS`);
      if (i < n - 1) parts.push(`${pendingBreak} MIN BREAK`);
    }
    cyclePreview.textContent = parts.join("  →  ");
  }

  settingsApplyBtn.addEventListener("click", () => {
    state.timer.durationMinutes = pendingDuration;
    state.timer.customMinutes = pendingCustomMinutes;
    state.timer.structure = pendingStructure;
    state.timer.breakMinutes = pendingBreak;
    state.timer.cycles = pendingCycles;
    resetTimer();
    closeSettingsModal();
    showToast("Session settings updated");
  });

  /* ---------------- History modal ---------------- */

  function openHistoryModal() {
    renderHistory();
    historyModalBackdrop.classList.add("open");
  }
  function closeHistoryModal() {
    historyModalBackdrop.classList.remove("open");
  }
  historyBtn.addEventListener("click", openHistoryModal);
  historyModalClose.addEventListener("click", closeHistoryModal);
  historyModalBackdrop.addEventListener("click", (e) => {
    if (e.target === historyModalBackdrop) closeHistoryModal();
  });

  function formatHM(totalSeconds) {
    const totalMin = Math.round(totalSeconds / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function renderHistory() {
    const today = todayISO();
    const todayEntries = state.history.filter((h) => h.date === today);
    const todayFocusedSec = todayEntries.reduce((s, h) => s + h.focusedSeconds, 0);
    const todayTasksCount = todayEntries.reduce((s, h) => s + h.tasksCompleted, 0);

    todayFocused.textContent = formatHM(todayFocusedSec);
    todaySessions.textContent = String(todayEntries.length);
    todayTasks.textContent = String(todayTasksCount);

    // Last 7 days including today
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const label = d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2).toUpperCase();
      days.push({ iso, label, isToday: iso === today });
    }

    const weekEntries = state.history.filter((h) => days.some((d) => d.iso === h.date));
    const weekFocusedSec = weekEntries.reduce((s, h) => s + h.focusedSeconds, 0);
    weekFocused.textContent = formatHM(weekFocusedSec);
    weekSessions.textContent = String(weekEntries.length);

    const perDay = days.map((d) => {
      const secs = state.history.filter((h) => h.date === d.iso).reduce((s, h) => s + h.focusedSeconds, 0);
      return { ...d, secs };
    });
    const maxSecs = Math.max(1, ...perDay.map((d) => d.secs));

    weekChart.innerHTML = "";
    perDay.forEach((d) => {
      const col = document.createElement("div");
      col.className = "week-bar-col";
      const bar = document.createElement("div");
      bar.className = "week-bar" + (d.isToday ? " today" : "");
      const heightPct = d.secs > 0 ? Math.max(6, Math.round((d.secs / maxSecs) * 100)) : 3;
      bar.style.height = `${heightPct}%`;
      const label = document.createElement("div");
      label.className = "week-bar-label";
      label.textContent = d.label;
      col.appendChild(bar);
      col.appendChild(label);
      weekChart.appendChild(col);
    });
  }

  /* ---------------- Focus mode ---------------- */

  function enterFocusMode() {
    state.focusMode = true;
    appEl.classList.add("focus-mode");
    saveState();
  }

  function exitFocusMode() {
    state.focusMode = false;
    appEl.classList.remove("focus-mode");
    saveState();
  }

  function toggleFocusMode() {
    if (state.focusMode) exitFocusMode();
    else enterFocusMode();
  }

  focusModeBtn.addEventListener("click", toggleFocusMode);

  /* ---------------- Keyboard shortcuts ---------------- */

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function anyModalOpen() {
    return settingsModalBackdrop.classList.contains("open") || historyModalBackdrop.classList.contains("open");
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (anyModalOpen()) {
        closeSettingsModal();
        closeHistoryModal();
      } else if (priorityMenuEl && priorityMenuEl.classList.contains("open")) {
        closePriorityMenu();
      } else if (state.focusMode) {
        exitFocusMode();
      } else if (document.activeElement && isTypingTarget(document.activeElement)) {
        document.activeElement.blur();
      }
      return;
    }

    if (isTypingTarget(document.activeElement)) return;
    if (anyModalOpen()) return;

    switch (e.key.toLowerCase()) {
      case " ":
        e.preventDefault();
        toggleStartPause();
        break;
      case "r":
        resetTimer();
        showToast("Timer reset");
        break;
      case "n":
        e.preventDefault();
        if (state.focusMode) exitFocusMode();
        taskInput.focus();
        break;
      case "f":
        toggleFocusMode();
        break;
      default:
        break;
    }
  });

  /* ---------------- Init ---------------- */

  function init() {
    initRing();
    sessionNameInput.value = state.session.name;
    sessionNotes.value = state.session.notes;
    applyNotesState();
    sortSelect.value = state.sortMode;

    currentPlan = buildPlan();
    // If persisted plan index is out of range (e.g. settings changed elsewhere), clamp it.
    if (state.timer.planIndex >= currentPlan.length) state.timer.planIndex = 0;
    if (!state.timer.remainingSeconds || state.timer.completed) {
      state.timer.remainingSeconds = segmentTotalSeconds(currentSegment());
    }

    if (state.focusMode) appEl.classList.add("focus-mode");

    renderTasks();
    renderTimer();
    renderSessionStats();

    if (state.timer.completed) {
      const completedCount = state.session.tasksCompletedThisSession;
      const remainingCount = state.tasks.length;
      const total = completedCount + remainingCount;
      const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;
      completeFocused.textContent = formatMMSS(state.session.focusedSeconds);
      completeTasks.textContent = `${completedCount}/${total}`;
      completePct.textContent = `${pct}%`;
      completeOverlay.classList.add("visible");
    }

    saveState();
  }

  init();

  // Persist on tab close to catch any last-second state.
  window.addEventListener("beforeunload", saveState);
})();
