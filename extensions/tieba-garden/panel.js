const el = (id) => document.getElementById(id);
const invoke = (cmd, args) => window.CyrenePanel.invoke("forum", cmd, args);
function button(label, run) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => action(run);
  return b;
}
async function action(run) {
  try {
    el("status").textContent = "处理中…";
    await run();
    el("status").textContent = "已完成";
  } catch (e) {
    el("status").textContent = e.message;
  }
}
function show(state) {
  el("replies").checked = !!state.config.replies;
  el("bar").value = state.config.bar;
  el("auto").checked = state.config.auto;
  el("learn").checked = state.config.learn;
  el("samples").replaceChildren(
    ...state.samples.map((s) => {
      const p = document.createElement("p");
      p.textContent = s.quote + " · " + s.scene + " ";
      p.append(
        button("出处", async () => {
          el("url").value = s.source;
        }),
        button("忘记", async () => show(await invoke("forget", { id: s.id }))),
      );
      return p;
    }),
  );
  el("reading").textContent = [
    ...(state.reading?.floors ?? []).map(
      (f) => (f.reply ? "楼中楼 · " : "") + f.body,
    ),
    state.reading?.replyStatus,
  ]
    .filter(Boolean)
    .join("\n\n");
  el("status").textContent = state.status ?? "";
}
el("save").onclick = () =>
  action(async () =>
    show(
      await invoke("save", {
        replies: el("replies").checked,
        bar: el("bar").value,
        auto: el("auto").checked,
        learn: el("learn").checked,
      }),
    ),
  );
el("browse").onclick = () =>
  action(async () => {
    const rows = await invoke("discover");
    el("threads").replaceChildren(
      ...rows.map((r) =>
        button(r.title, async () => {
          el("url").value = "https://tieba.baidu.com/p/" + r.id;
          el("excerpt").value = "";
          show(await invoke("read", { url: el("url").value }));
        }),
      ),
    );
  });
el("read").onclick = () =>
  action(async () =>
    show(
      await invoke("read", {
        url: el("url").value,
        excerpt: el("excerpt").value,
      }),
    ),
  );
invoke("state")
  .then(show)
  .catch((e) => {
    el("status").textContent = e.message;
  });
