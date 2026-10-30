import { escapeHTML, icon } from "./shared.mjs";

export function createBookSourceSettings({ api, post, toast }) {
  const panel = document.getElementById("settings-source");
  let loading = false;
  async function show() {
    if (loading) return;
    loading = true;
    try {
      const config = await api("/api/book-source/settings");
      panel.innerHTML = `<form class="service-form"><div class="service-heading"><span class="service-symbol">${icon("search")}</span><div><h2>Z-Library</h2></div></div><fieldset><legend class="visually-hidden">书源账号</legend>
        <label class="service-field">账号邮箱<input name="email" type="email" required maxlength="320" autocomplete="username" value="${escapeHTML(config.email)}"></label>
        <label class="service-field">密码<input name="password" type="password" maxlength="4096" autocomplete="new-password" placeholder="${config.hasPassword ? "已保存，留空保持现有密码" : "填写账号密码"}"></label>
        <div class="service-actions"><button class="primary-button" type="submit">保存设置</button><button class="secondary-button" type="button" data-test ${config.hasPassword ? "" : "disabled"}>测试连接</button><a href="#/source">去找书</a></div></fieldset><p class="service-result" data-result role="status" aria-live="polite"></p></form>
        <div class="source-component" ${config.installed ? "hidden" : ""}><p data-component-state>搜索组件未安装</p><button class="secondary-button" data-install ${config.installed ? "hidden" : ""}>安装组件</button></div>`;
      const form = panel.querySelector("form"),
        result = panel.querySelector("[data-result]");
      const message = (text, kind = "") => {
        result.textContent = text;
        result.dataset.kind = kind;
      };
      async function run(save) {
        form.querySelector("fieldset").disabled = true;
        message(save ? "正在保存…" : "连接中…");
        try {
          if (save) {
            await post("/api/book-source/settings", {
              email: form.elements.email.value,
              password: form.elements.password.value,
            });
            form.elements.password.value = "";
            toast("账号已保存。", { kind: "success" });
            loading = false;
            await show();
          } else {
            const response = await post("/api/book-source/query", {
              operation: "limits",
            });
            const source = response.sources?.zlibrary;
            if (!source?.configured || source.error)
              throw Error("无法连接书源，请检查账号或网络。");
            message("连接成功", "success");
          }
        } catch (error) {
          message(error.message, "error");
        } finally {
          form.querySelector("fieldset").disabled = false;
        }
      }
      form.onsubmit = (event) => {
        event.preventDefault();
        run(true);
      };
      form.oninput = () => {
        message("未保存");
        form.querySelector("[data-test]").disabled = true;
      };
      form.querySelector("[data-test]").onclick = () => run(false);
      panel.querySelector("[data-install]").onclick = async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          let task = await post("/api/book-source/install", {});
          while (task.status === "running") {
            panel.querySelector("[data-component-state]").textContent =
              "正在安装…";
            await new Promise((resolve) => setTimeout(resolve, 1500));
            task = await api("/api/book-source/component");
          }
          if (task.status !== "ready")
            throw Error(task.error || "组件安装未完成。");
          button.hidden = true;
          panel.querySelector(".source-component").hidden = true;
        } catch (error) {
          message(error.message, "error");
        } finally {
          button.disabled = false;
        }
      };
    } catch (error) {
      panel.textContent = error.message;
    } finally {
      loading = false;
    }
  }
  return { show };
}
