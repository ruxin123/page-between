import { escapeHTML, icon } from "./shared.mjs";

export function translationSettingsMarkup(config, saved) {
  const inherited = config.useChatModel;
  return `<form class="service-form" data-service="translation">
  <div class="service-heading"><span class="service-symbol">${icon("translate")}</span><div><h2>划词翻译</h2><span class="service-badge" data-ready="${config.ready}">${config.ready ? "可使用" : "需要配置 AI 模型"}</span></div></div>

  <fieldset>
   <label class="service-field">默认服务<select name="provider"><option value="ai" ${config.provider === "ai" ? "selected" : ""}>AI 翻译</option><option value="google" ${config.provider === "google" ? "selected" : ""}>Google 翻译</option></select></label>
   <div data-google-note class="service-note" ${config.provider === "google" ? "" : "hidden"}><strong>Google 网页翻译</strong><p>无需 Key，需能访问 Google。</p></div>
   <div data-ai-options ${config.provider === "ai" ? "" : "hidden"}>
    <label class="setting-check">沿用 AI 答疑的模型<input name="useChatModel" type="checkbox" ${inherited ? "checked" : ""}></label>
    <p data-inherited-note class="setting-note" ${inherited ? "" : "hidden"}>${saved.services.ai.ready ? "" : "尚未配置答疑模型。"}</p>
   </div>
   <fieldset data-translation-model ${inherited || config.provider === "google" ? "disabled hidden" : ""}>
    <legend>翻译模型</legend>
    <label class="service-field">服务地址<input name="baseUrl" type="url" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://…/v1" value="${escapeHTML(config.baseUrl)}"><small>兼容 Chat Completions；本机可用 HTTP。</small></label>
    <label class="service-field">模型名称<input name="model" type="text" required maxlength="200" autocomplete="off" spellcheck="false" value="${escapeHTML(config.model)}" placeholder="填写模型 ID"></label>
    <label class="service-field">API Key<input name="key" type="password" maxlength="4096" autocomplete="new-password" placeholder="${config.hasKey ? "已保存，留空保持现有凭据" : "本机模型可留空"}"><small>独立保存于钥匙串。</small></label>
    ${config.hasKey ? '<label class="setting-check">移除翻译专用凭据<input name="removeKey" type="checkbox"></label>' : ""}
   </fieldset>
   <div class="service-actions"><button type="submit" class="primary-button">保存设置</button><button type="button" class="secondary-button" data-test>测试连接</button><button type="button" class="service-reset" data-reset>还原修改</button></div>
  </fieldset><p class="service-result" data-result role="status" aria-live="polite"></p>
 </form>
 <details class="service-help"><summary>使用说明</summary><p>AI 可使用独立模型，默认沿用答疑配置。Google 使用网页接口，仅发送原文；AI 还会接收少量附近文字。记录保存在本机。</p></details>`;
}

export function updateTranslationFields(form) {
  if (form.dataset.service !== "translation") return;
  const google = form.elements.provider.value === "google",
    inherit = form.elements.useChatModel.checked;
  form.querySelector("[data-google-note]").hidden = !google;
  form.querySelector("[data-ai-options]").hidden = google;
  form.querySelector("[data-inherited-note]").hidden = !inherit;
  const model = form.querySelector("[data-translation-model]");
  model.hidden = google || inherit;
  model.disabled = google || inherit;
}
