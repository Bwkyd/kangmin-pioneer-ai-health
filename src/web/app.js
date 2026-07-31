const scoreNames = [
  "sneezing",
  "runnyNose",
  "nasalCongestion",
  "nasalItching",
];

const state = {
  records: [],
  selected: null,
  busy: false,
};

const form = document.querySelector('[data-testid="symptom-form"]');
const dateInput = document.querySelector('[data-testid="record-date"]');
const notesInput = document.querySelector('[data-testid="notes"]');
const saveButton = document.querySelector('[data-testid="save-button"]');
const refreshButton = document.querySelector('[data-testid="refresh-button"]');
const notice = document.querySelector('[data-testid="notice"]');
const scorePreview = document.querySelector('[data-testid="score-preview"]');
const formTitle = document.querySelector('[data-testid="form-title"]');
const recordList = document.querySelector('[data-testid="record-list"]');
const recordCount = document.querySelector('[data-testid="record-count"]');
const emptyState = document.querySelector('[data-testid="empty-state"]');
const centralAdd = document.querySelector('[data-testid="central-add"]');
const calendarNav = document.querySelector('[data-testid="calendar-nav"]');

class CommandError extends Error {
  constructor(result, status) {
    super(result?.error?.message || "请求失败");
    this.name = "CommandError";
    this.code = result?.error?.code || "network_error";
    this.status = status;
    this.details = result?.error?.details || {};
  }
}

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatDate(value) {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function label(total) {
  if (total <= 3) return "轻度";
  if (total <= 7) return "中度";
  return "较重";
}

function scores() {
  const result = {};
  for (const name of scoreNames) {
    const checked = form.querySelector(`input[name="${name}"]:checked`);
    if (!checked) return null;
    result[name] = Number(checked.value);
  }
  return result;
}

function setBusy(value) {
  state.busy = value;
  refreshButton.disabled = value;
  updatePreview();
}

function showNotice(kind, message) {
  notice.className = `notice ${kind}`;
  notice.textContent = message;
}

function hideNotice() {
  notice.className = "notice hidden";
  notice.textContent = "";
}

async function command(name, input = {}) {
  let response;
  try {
    response = await fetch("/v1/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: name,
        input,
        requestId: crypto.randomUUID(),
      }),
    });
  } catch (error) {
    throw new CommandError({
      error: {
        code: "network_error",
        message: "网络连接失败，请稍后重试",
        details: { cause: String(error) },
      },
    }, 0);
  }

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new CommandError(result, response.status);
  }
  return result.data;
}

async function createDevelopmentSession() {
  const response = await fetch("/dev/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "patient-web" }),
  });
  if (!response.ok) {
    throw new CommandError(
      {
        error: {
          code: response.status === 404
            ? "authentication_required"
            : "development_session_failed",
          message: "需要完成患者登录后才能读取或保存健康记录",
        },
      },
      response.status
    );
  }
}

function setScore(name, value) {
  const input = form.querySelector(
    `input[name="${name}"][value="${value}"]`
  );
  if (input) input.checked = true;
}

function resetForm() {
  form.reset();
  notesInput.value = "";
  state.selected = null;
  formTitle.textContent = "新增症状记录";
  saveButton.textContent = "保存症状记录";
  updatePreview();
}

function selectDate(value) {
  dateInput.value = value;
  const record = state.records.find((item) => item.localDate === value);
  if (!record) {
    resetForm();
    dateInput.value = value;
    return;
  }

  state.selected = record;
  setScore("sneezing", record.sneezing);
  setScore("runnyNose", record.runnyNose);
  setScore("nasalCongestion", record.nasalCongestion);
  setScore("nasalItching", record.nasalItching);
  notesInput.value = record.notes || "";
  formTitle.textContent = "修改症状记录";
  saveButton.textContent = `保存修改 · 版本 ${record.revision}`;
  updatePreview();
}

function recordCard(record) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-card";
  button.dataset.recordId = record.id;
  button.innerHTML = `
    <span class="history-date">${formatDate(record.localDate)}</span>
    <strong>TNSS ${record.tnssTotal}</strong>
    <span class="severity">${label(record.tnssTotal)}</span>
    <small>喷嚏 ${record.sneezing} · 流涕 ${record.runnyNose} · 鼻塞 ${record.nasalCongestion} · 鼻痒 ${record.nasalItching}</small>
  `;
  button.addEventListener("click", () => {
    selectDate(record.localDate);
    document.querySelector(".record-card").scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
  return button;
}

function renderHistory() {
  recordList.replaceChildren(
    ...state.records.map((record) => recordCard(record))
  );
  recordCount.textContent = `${state.records.length} 条`;
  emptyState.classList.toggle("hidden", state.records.length > 0);
}

function updatePreview() {
  const values = scores();
  const complete = values !== null;
  scorePreview.textContent = complete
    ? String(Object.values(values).reduce((sum, value) => sum + value, 0))
    : "—";
  saveButton.disabled = state.busy || !complete;
}

async function loadRecords({ establishSession = true } = {}) {
  setBusy(true);
  try {
    let result;
    try {
      result = await command("record symptom list");
    } catch (error) {
      if (
        establishSession &&
        error instanceof CommandError &&
        error.code === "authentication_required"
      ) {
        await createDevelopmentSession();
        result = await command("record symptom list");
      } else {
        throw error;
      }
    }

    state.records = result.items;
    renderHistory();
    selectDate(dateInput.value || localDate());
    hideNotice();
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "症状记录读取失败";
    showNotice("error", message);
  } finally {
    setBusy(false);
  }
}

form.addEventListener("change", updatePreview);
dateInput.addEventListener("change", () => selectDate(dateInput.value));
refreshButton.addEventListener("click", () =>
  loadRecords({ establishSession: false })
);
centralAdd.addEventListener("click", () => {
  selectDate(localDate());
  document.querySelector(".record-card").scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
});
calendarNav.addEventListener("click", () => {
  document.querySelector(".history-section").scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = scores();
  if (!values) return;

  setBusy(true);
  hideNotice();
  try {
    let successMessage;
    if (state.selected) {
      await command("record symptom update", {
        id: state.selected.id,
        expectedRevision: state.selected.revision,
        ...values,
        notes: notesInput.value.trim() || null,
      });
      successMessage = "症状记录已更新，并已保存到服务端";
    } else {
      await command("record symptom add", {
        localDate: dateInput.value,
        ...values,
        notes: notesInput.value.trim() || null,
        idempotencyKey: `web-symptom-${dateInput.value}`,
      });
      successMessage = "症状记录已保存到服务端";
    }
    await loadRecords({ establishSession: false });
    showNotice("success", successMessage);
  } catch (error) {
    if (
      error instanceof CommandError &&
      (error.code === "version_conflict" ||
        error.code === "idempotency_conflict")
    ) {
      showNotice(
        "warning",
        "记录已在其它页面发生变化。请点击“重新读取”后确认最新内容。"
      );
    } else {
      showNotice(
        "error",
        error instanceof Error ? error.message : "保存失败，请稍后重试"
      );
    }
  } finally {
    setBusy(false);
  }
});

dateInput.value = localDate();
await loadRecords();
