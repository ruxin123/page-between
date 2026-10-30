import {
  translationSettingsMarkup,
  updateTranslationFields,
} from "./translation-settings.mjs";
import { escapeHTML } from "/ui/shared.mjs";

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
    const container = $("settings-" + service);
    container.innerHTML =
      service === "translation"
        ? translationSettingsMarkup(config, saved)
        : `<form class="service-form" data-service="${service}">
      <fieldset><legend class="visually-hidden">${ai ? "模型服务配置" : "MinerU 服务配置"}</legend>
        <label class="service-field">服务地址<input name="baseUrl" type="url" maxlength="2048" required spellcheck="false" autocomplete="off" placeholder="${ai ? "https://…/v1" : "https://mineru.net/api/v4"}" value="${escapeHTML(config.baseUrl)}"></label>
        <label class="service-field">${ai ? "模型名称" : "解析模型"}${ai ? `<input name="model" type="text" maxlength="200" required spellcheck="false" autocomplete="off" placeholder="模型 ID" value="${escapeHTML(config.model)}">` : `<select name="model"><option value="vlm" ${config.model === "vlm" ? "selected" : ""}>VLM</option><option value="pipeline" ${config.model === "pipeline" ? "selected" : ""}>Pipeline</option></select>`}</label>
        ${ai ? `<label class="setting-check">支持图像输入<input name="supportsImages" type="checkbox" ${config.supportsImages ? "checked" : ""}></label>` : ""}
        <label class="service-field">${ai ? "API Key" : "API Token"}<input name="key" type="password" maxlength="4096" autocomplete="new-password" spellcheck="false" placeholder="${config.hasKey ? "已保存，留空保持现有凭据" : ai ? "填写 Key；本机模型可留空" : "填写 MinerU Token"}"></label>
        ${config.hasKey ? '<label class="setting-check remove-key">移除已保存的凭据<input type="checkbox" name="removeKey"></label>' : ""}
        <p class="service-storage-note">${saved.keychainAvailable ? "" : "钥匙串不可用，暂时无法保存凭据。"}</p>
        <div class="service-actions"><button type="submit" class="primary-button">保存设置</button><button type="button" class="secondary-button" data-test>${ai ? "测试连接" : "检查配置"}</button><button type="button" class="service-reset" data-reset>还原修改</button></div>
      </fieldset><p class="service-result" data-result role="status" aria-live="polite"></p></form>`;
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
      updateTranslationFields(form);
      form.querySelector("[data-result]").textContent = "未保存";
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
    if (service === "translation") {
      config.provider = form.elements.provider.value;
      config.useChatModel = form.elements.useChatModel.checked;
    }
    if (service === "ai")
      config.supportsImages = form.elements.supportsImages.checked;
    const result = form.querySelector("[data-result]");
    form.dataset.busy = "true";
    form.setAttribute("aria-busy", "true");
    form.querySelector("fieldset").disabled = true;
    result.dataset.kind = "";
    result.textContent = saving
      ? "正在保存…"
      : ["ai", "translation"].includes(service)
        ? "连接中…"
        : "检查中…";
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
          : "已保存。";
        const status = $("settings-" + service).querySelector("[data-result]");
        status.textContent = data.cleanupWarning ? message : "";
        status.dataset.kind = data.cleanupWarning ? "warning" : "success";
        toast(message, { kind: data.cleanupWarning ? "warning" : "success" });
      } else {
        result.textContent = data.verified === false ? "格式有效" : "连接成功";
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
    if (
      !["reading", "ai", "translation", "mineru", "data", "source"].includes(
        section,
      )
    )
      section = "reading";
    for (const tab of tabs) {
      const selected = tab.dataset.settingsTab === section;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $("settings-" + tab.dataset.settingsTab).hidden = !selected;
    }
    if (["reading", "data", "source"].includes(section) || saved) return;
    if (!loading)
      loading = (async () => {
        $("settings-load-status").textContent = "读取设置…";
        try {
          saved = await api("/api/settings");
          render("ai");
          render("mineru");
          render("translation");
          $("settings-load-status").textContent = "";
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
