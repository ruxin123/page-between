import { escapeHTML, icon } from "/ui/shared.mjs";

export function createServiceSettings({ document, api, post, toast }) {
  const $ = (id) => document.getElementById(id);
  let saved, loading;
  const tabs = [...document.querySelectorAll("[data-settings-tab]")];
  for (const [index, tab] of tabs.entries()) {
    tab.onclick = () => {
      window.location.hash = "#/settings/" + tab.dataset.settingsTab;
    };
    tab.onkeydown = (event) => {
      const target =
        event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : -1;
      if (target < 0) return;
      event.preventDefault();
      tabs[target].click();
      tabs[target].focus();
    };
  }
  function render(service) {
    const config = saved.services[service],
      ai = service === "ai";
    const title = ai
      ? "为书中的疑问，接上一个好帮手"
      : "为复杂版面，多准备一种解法";
    const description = ai
      ? "接入你选择的模型，用来解释术语、翻译和讨论书中内容。"
      : "EPUB 沿用原书结构。扫描 PDF 可通过文档解析补足文字、公式与图表。";
    const container = $("settings-" + service);
    container.innerHTML = `<form class="service-form" data-service="${service}">
      <div class="service-heading"><span class="service-symbol">${icon(ai ? "ask" : "pages")}</span><div><h2>${ai ? "模型服务" : "MinerU 云解析"}</h2><span class="service-badge" data-ready="${config.ready}">${ai ? (config.ready ? "已配置" : "尚未配置") : config.ready ? "按需启用" : "尚未配置"}</span></div></div>
      <p class="service-description">${description}</p>
      <fieldset><legend class="visually-hidden">${ai ? "模型服务配置" : "MinerU 服务配置"}</legend>
        <label class="service-field">服务地址<input name="baseUrl" type="url" maxlength="2048" required spellcheck="false" autocomplete="off" placeholder="${ai ? "https://…/v1" : "https://mineru.net/api/v4"}" value="${escapeHTML(config.baseUrl)}"><small>${ai ? "使用兼容 Chat Completions 的接口；本机模型可用回环 HTTP 地址。" : "填写 MinerU 云服务的 API v4 根地址。"}</small></label>
        <label class="service-field">${ai ? "模型名称" : "解析模型"}${ai ? `<input name="model" type="text" maxlength="200" required spellcheck="false" autocomplete="off" placeholder="填写服务商提供的模型 ID" value="${escapeHTML(config.model)}">` : `<select name="model"><option value="vlm" ${config.model === "vlm" ? "selected" : ""}>VLM · 复杂版面</option><option value="pipeline" ${config.model === "pipeline" ? "selected" : ""}>Pipeline · 通用解析</option></select>`}</label>
        <label class="service-field">${ai ? "API Key" : "API Token"}<input name="key" type="password" maxlength="4096" autocomplete="new-password" spellcheck="false" placeholder="${config.hasKey ? "已保存，留空保持现有凭据" : ai ? "填写 Key；本机模型可留空" : "填写 MinerU Token"}" aria-describedby="${service}-key-note"><small id="${service}-key-note">${config.hasKey ? (config.source === "environment" ? "正在沿用现有凭据。保存后转交 macOS 钥匙串管理。" : "凭据保存在 macOS 钥匙串中，不回显原值。") : "凭据仅由本机服务读取，保存到 macOS 钥匙串。"}</small></label>
        ${config.hasKey ? '<label class="setting-check remove-key">移除已保存的凭据<input type="checkbox" name="removeKey"></label>' : ""}
        <p class="service-storage-note">${saved.keychainAvailable ? "保存后立即生效。" : "钥匙串组件当前不可用，含凭据的配置暂时不能保存。"}${config.source === "environment" ? "当前使用已有配置。" : ""}</p>
        <div class="service-actions"><button type="submit" class="primary-button">保存设置</button><button type="button" class="secondary-button" data-test>${ai ? "测试连接" : "检查配置"}</button><button type="button" class="service-reset" data-reset>还原修改</button></div>
      </fieldset><p class="service-result" data-result role="status" aria-live="polite"></p></form>
      <aside class="service-explainer"><small>${ai ? "陪你读懂" : "原书优先"}</small><h2>${title}</h2>
        ${ai ? `<p>选中原文就能提问，也可以围绕当前页发起讨论。对话与出处保存在这台设备。</p><div class="service-note"><strong>发送范围由你掌握</strong><p>发问时会发送选段、附近文字和近期对话。阅读与复制在本机完成。</p></div><div class="service-note"><strong>先试一句，再开始阅读</strong><p>「测试连接」发送一句简短测试文字，使用当前表单配置。测试通过后请保存设置。</p></div>` : `<p>当前阅读器使用本机 OCR 增强 PDF 的目录和文字选择，导入时可以单独开关。</p><div class="service-note"><strong>先选一小段，再增强整本</strong><p>在 PDF 的书籍设置里选择「精细解析」，可以指定页段、暂停并继续。这里只检查配置格式，Token 有效性在实际任务中确认。</p></div><div class="service-note"><strong>已有好格式，保留好排版</strong><p>EPUB 直接使用原书目录、插图与正文。MinerU 用于扫描教材等复杂资料。</p></div>`}
      </aside>`;
    const form = container.querySelector("form");
    form.onsubmit = (event) => {
      event.preventDefault();
      run(form, true);
    };
    form.querySelector("[data-test]").onclick = () => {
      if (form.reportValidity()) run(form, false);
    };
    form.querySelector("[data-reset]").onclick = () => render(service);
    form.oninput = () => {
      form.querySelector("[data-result]").textContent = "有修改尚未保存。";
      form.querySelector("[data-result]").dataset.kind = "";
    };
  }
  async function run(form, saving) {
    if (form.dataset.busy) return;
    const service = form.dataset.service;
    const config = {
      baseUrl: form.elements.baseUrl.value.trim(),
      model: form.elements.model.value.trim(),
      key: form.elements.key.value,
      removeKey: form.elements.removeKey?.checked || false,
    };
    const result = form.querySelector("[data-result]");
    form.dataset.busy = "true";
    form.setAttribute("aria-busy", "true");
    form.querySelector("fieldset").disabled = true;
    result.dataset.kind = "";
    result.textContent = saving
      ? "正在保存…"
      : service === "ai"
        ? "正在连接模型，最多等待 45 秒…"
        : "正在检查填写内容…";
    try {
      const data = await post("/api/settings/" + (saving ? "save" : "test"), {
        service,
        config,
      });
      if (saving) {
        saved = data;
        render(service);
        const message = data.cleanupWarning
          ? "新配置已保存；旧凭据清理未完成，可稍后检查钥匙串。"
          : "设置已保存，之后的新请求将使用这份配置。";
        const status = $("settings-" + service).querySelector("[data-result]");
        status.textContent = message;
        status.dataset.kind = data.cleanupWarning ? "warning" : "success";
        toast(message, { kind: data.cleanupWarning ? "warning" : "success" });
      } else {
        result.textContent = data.message;
        result.dataset.kind = data.verified === false ? "" : "success";
      }
    } catch (error) {
      result.textContent = error.message;
      result.dataset.kind = "error";
    } finally {
      delete form.dataset.busy;
      form.setAttribute("aria-busy", "false");
      form.querySelector("fieldset").disabled = false;
    }
  }
  async function show(section = "reading") {
    if (!["reading", "ai", "mineru", "data"].includes(section))
      section = "reading";
    for (const tab of tabs) {
      const selected = tab.dataset.settingsTab === section;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $("settings-" + tab.dataset.settingsTab).hidden = !selected;
    }
    if (["reading", "data"].includes(section) || saved) return;
    if (!loading)
      loading = (async () => {
        $("settings-load-status").textContent = "正在读取本机服务设置…";
        try {
          saved = await api("/api/settings");
          render("ai");
          render("mineru");
          $("settings-load-status").textContent =
            saved.profile === "demo" ? "演示模式的应用设置独立保存。" : "";
        } catch (error) {
          $("settings-load-status").textContent = error.message;
          toast(error.message, { kind: "error" });
        } finally {
          loading = null;
        }
      })();
    await loading;
  }
  return { show };
}
