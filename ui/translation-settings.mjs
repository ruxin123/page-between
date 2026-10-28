import { escapeHTML, icon } from "./shared.mjs";

export function translationSettingsMarkup(config, saved) {
  const inherited = config.useChatModel;
  return `<form class="service-form" data-service="translation">
  <div class="service-heading"><span class="service-symbol">${icon("translate")}</span><div><h2>阅读翻译</h2><span class="service-badge" data-ready="${config.ready}">${config.ready ? "可使用" : "需要配置 AI 模型"}</span></div></div>
  <p class="service-description">设置默认翻译服务。翻译窗口也可以临时切换服务并重新翻译。</p>
  <fieldset>
   <label class="service-field">默认翻译服务<select name="provider"><option value="ai" ${config.provider === "ai" ? "selected" : ""}>AI 翻译</option><option value="google" ${config.provider === "google" ? "selected" : ""}>Google 翻译</option></select></label>
   <div data-google-note class="service-note" ${config.provider === "google" ? "" : "hidden"}><strong>Google 网页翻译</strong><p>与 Bob Google 插件的网页接口方式相同，无需 API Key。仅发送当前原文，不发送附近内容。需要能访问 Google 的网络；接口变化或限流时可在窗口中切换 AI。</p></div>
   <div data-ai-options ${config.provider === "ai" ? "" : "hidden"}>
    <label class="setting-check">沿用 AI 答疑的模型<input name="useChatModel" type="checkbox" ${inherited ? "checked" : ""}></label>
    <p data-inherited-note class="setting-note" ${inherited ? "" : "hidden"}>${saved.services.ai.ready ? "使用「AI 答疑」中已配置的模型和凭据。" : "当前尚未配置 AI 答疑模型；可前往配置，或取消勾选并设置专用模型。"}</p>
   </div>
   <fieldset data-translation-model ${inherited || config.provider === "google" ? "disabled hidden" : ""}>
    <legend>翻译专用模型</legend>
    <label class="service-field">服务地址<input name="baseUrl" type="url" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://…/v1" value="${escapeHTML(config.baseUrl)}"><small>兼容 Chat Completions；本机模型可使用回环 HTTP 地址。</small></label>
    <label class="service-field">模型名称<input name="model" type="text" required maxlength="200" autocomplete="off" spellcheck="false" value="${escapeHTML(config.model)}" placeholder="填写模型 ID"></label>
    <label class="service-field">API Key<input name="key" type="password" maxlength="4096" autocomplete="new-password" placeholder="${config.hasKey ? "已保存，留空保持现有凭据" : "本机模型可留空"}"><small>独立保存在 macOS 钥匙串，不改变 AI 答疑的凭据。</small></label>
    ${config.hasKey ? '<label class="setting-check">移除翻译专用凭据<input name="removeKey" type="checkbox"></label>' : ""}
   </fieldset>
   <div class="service-actions"><button type="submit" class="primary-button">保存设置</button><button type="button" class="secondary-button" data-test>测试翻译连接</button><button type="button" class="service-reset" data-reset>还原修改</button></div>
  </fieldset><p class="service-result" data-result role="status" aria-live="polite"></p>
 </form>
 <aside class="service-explainer"><small>读懂，再继续</small><h2>保留书中的公式与层次</h2><p>原文与译文都支持 Markdown、数学公式、列表和表格。原文默认显示排版预览，需要修改时再展开编辑。</p><div class="service-note"><strong>不同服务，各取所长</strong><p>Google 直接翻译原文；AI 还可结合少量附近文字解释术语。选段只有在主动翻译时才发送，记录保存在本机。</p></div><div class="service-note"><strong>一份选段，两种译法</strong><p>在翻译窗口切换服务后重新翻译，或继续交给书内答疑深入讨论。没有配置 AI 模型时，仍可选择 Google。</p></div></aside>`;
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
