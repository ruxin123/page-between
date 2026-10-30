import { escapeHTML } from "./shared.mjs";

export function translationSettingsMarkup(config, saved) {
  const inherited = config.useChatModel;
  return `<form class="service-form" data-service="translation">
  <fieldset>
   <label class="service-field">默认服务<select name="provider"><option value="ai" ${config.provider === "ai" ? "selected" : ""}>AI 翻译</option><option value="google" ${config.provider === "google" ? "selected" : ""}>Google 翻译</option></select></label>

   <div data-ai-options ${config.provider === "ai" ? "" : "hidden"}>
    <label class="setting-check">沿用 AI 答疑的模型<input name="useChatModel" type="checkbox" ${inherited ? "checked" : ""}></label>
    <a data-inherited-note data-configured="${saved.services.ai.ready}" href="#/settings/ai" ${inherited && !saved.services.ai.ready ? "" : "hidden"}>配置答疑模型</a>
   </div>
   <fieldset data-translation-model ${inherited || config.provider === "google" ? "disabled hidden" : ""}>
    <legend class="visually-hidden">翻译模型</legend>
    <label class="service-field">服务地址<input name="baseUrl" type="url" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://…/v1" value="${escapeHTML(config.baseUrl)}"></label>
    <label class="service-field">模型名称<input name="model" type="text" required maxlength="200" autocomplete="off" spellcheck="false" value="${escapeHTML(config.model)}" placeholder="模型 ID"></label>
    <label class="service-field">API Key<input name="key" type="password" maxlength="4096" autocomplete="new-password" placeholder="${config.hasKey ? "已保存，留空保持现有凭据" : "本机模型可留空"}"></label>
    ${config.hasKey ? '<label class="setting-check">移除翻译专用凭据<input name="removeKey" type="checkbox"></label>' : ""}
   </fieldset>
   <div class="service-actions"><button type="submit" class="primary-button">保存设置</button><button type="button" class="secondary-button" data-test>测试连接</button><button type="button" class="service-reset" data-reset>还原修改</button></div>
  </fieldset><p class="service-result" data-result role="status" aria-live="polite"></p>
 </form>`;
}

export function updateTranslationFields(form) {
  if (form.dataset.service !== "translation") return;
  const google = form.elements.provider.value === "google",
    inherit = form.elements.useChatModel.checked;
  form.querySelector("[data-ai-options]").hidden = google;
  const note = form.querySelector("[data-inherited-note]");
  note.hidden = !inherit || note.dataset.configured === "true";
  const model = form.querySelector("[data-translation-model]");
  model.hidden = google || inherit;
  model.disabled = google || inherit;
}
