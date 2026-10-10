// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Nhóm "Đồ án" (HL 3D): lưu / mở đồ án trong một thư mục trên máy, mở thư mục bằng File Explorer.
// Cần máy chủ nhỏ server.py chạy cùng app (mở bằng MO-APP.bat); không có thì dùng tải xuống như cũ.

import { command, type IApplication, type ICommand, PubSub, type Serialized } from "@chili3d/core";

const toast = (msg: string) => PubSub.default.pub("showToast", "toast.message{0}" as any, msg);

export async function localApi(): Promise<boolean> {
    try {
        const r = await fetch("/api/folder", { cache: "no-store" });
        return r.ok;
    } catch {
        return false;
    }
}

async function apiJson(path: string, init?: RequestInit) {
    const r = await fetch(path, { cache: "no-store", ...init });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? `Lỗi ${r.status}`);
    return j;
}

/** Lưu file vào thư mục đồ án (STL đi vào thư mục con STL). Trả về đường dẫn, hoặc undefined nếu không có máy chủ. */
export async function saveToProjectFolder(name: string, data: BlobPart, kind: "project" | "export") {
    if (!(await localApi())) return undefined;
    const j = await apiJson(`/api/${kind}?name=${encodeURIComponent(name)}`, { method: "POST", body: new Blob([data]) });
    return j.path as string;
}

function noServer() {
    toast("Chức năng này cần mở phần mềm bằng biểu tượng HL 3D (MO-APP.bat).");
}

const CSS = `
.pj{display:grid;gap:10px;min-width:min(520px,86vw);max-height:62vh;font-size:13px}
.pj .path{font-size:12px;opacity:.75;word-break:break-all}
.pj .list{display:grid;gap:4px;overflow:auto;max-height:46vh}
.pj .it{display:flex;justify-content:space-between;align-items:center;gap:10px;text-align:left;padding:8px 10px;border-radius:8px;
 border:1px solid var(--border-color);background:var(--control-background-color);color:inherit;cursor:pointer;font:inherit}
.pj .it:hover{border-color:var(--primary-color)}
.pj .it small{opacity:.65;white-space:nowrap}
.pj .row{display:flex;gap:8px;flex-wrap:wrap}
.pj .row button{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--border-color);background:var(--control-background-color);color:inherit;cursor:pointer}
.pj input{font:inherit;padding:7px 10px;border-radius:8px;border:1px solid var(--input-border-color);background:var(--input-background-color);color:var(--input-text-color);width:100%;box-sizing:border-box}
.pj .empty{opacity:.7;padding:12px 0}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
}

const fmtDate = (ms: number) =>
    new Date(ms).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

@command({ key: "project.save" as any, icon: "icon-save" })
export class SaveProjectCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const doc = app.activeView?.document;
        if (!doc) return toast("Chưa mở bản vẽ nào.");
        if (!(await localApi())) return noServer();
        const folder = (await apiJson("/api/folder")).folder as string;
        const input = el("input", { value: doc.name, id: "pj-name" }) as HTMLInputElement;
        const root = el(
            "div",
            { className: "pj" },
            el("style", { textContent: CSS }),
            el("label", {}, "Tên đồ án", input),
            el("div", { className: "path", textContent: `Lưu vào: ${folder}` }),
        );
        PubSub.default.pub("showDialog", "command.project.save" as any, root, async () => {
            const name = input.value.trim() || doc.name;
            try {
                doc.name = name;
                const data = JSON.stringify(doc.serialize());
                const path = await saveToProjectFolder(name, data, "project");
                await doc.save?.();
                toast(`Đã lưu đồ án: ${path}`);
            } catch (e) {
                toast(`Không lưu được: ${(e as Error).message}`);
            }
        });
        window.setTimeout(() => input.select(), 50);
    }
}

@command({ key: "project.open" as any, icon: "icon-folder" })
export class OpenProjectCommand implements ICommand {
    async execute(app: IApplication): Promise<void> {
        if (!(await localApi())) {
            PubSub.default.pub("executeCommand", "doc.open" as any);
            return;
        }
        const root = el("div", { className: "pj" }, el("style", { textContent: CSS }));
        const render = async () => {
            const j = await apiJson("/api/projects");
            const items = j.items as { name: string; size: number; mtime: number }[];
            const list = el("div", { className: "list" });
            if (!items.length)
                list.append(el("div", { className: "empty", textContent: "Thư mục chưa có đồ án nào. Bấm “Lưu đồ án” để lưu bản vẽ đang mở." }));
            for (const it of items) {
                const b = el(
                    "button",
                    { className: "it", type: "button", title: "Bấm để mở" },
                    el("span", { textContent: it.name.replace(/\.cd$/i, "") }),
                    el("small", { textContent: `${fmtDate(it.mtime)} · ${(it.size / 1024).toFixed(0)} KB` }),
                );
                b.addEventListener("click", async () => {
                    try {
                        const r = await fetch(`/api/project?name=${encodeURIComponent(it.name)}`, { cache: "no-store" });
                        const json = (await r.json()) as Serialized;
                        root.closest("dialog")?.remove();
                        const d = await app.loadDocument(json);
                        d?.application.activeView?.cameraController.fitContent();
                        toast(`Đã mở đồ án ${it.name}`);
                    } catch (e) {
                        toast(`Không mở được: ${(e as Error).message}`);
                    }
                });
                list.append(b);
            }
            const openFolder = el("button", { type: "button", textContent: "📂 Mở thư mục" });
            openFolder.addEventListener("click", () => void apiJson("/api/open-folder", { method: "POST" }));
            const change = el("button", { type: "button", textContent: "Đổi thư mục lưu…" });
            change.addEventListener("click", async () => {
                toast("Chọn thư mục trong cửa sổ vừa hiện ra…");
                const r = await apiJson("/api/choose-folder", { method: "POST" });
                if (r.changed) toast(`Thư mục đồ án: ${r.folder}`);
                await render();
            });
            const other = el("button", { type: "button", textContent: "Mở file khác…" });
            other.addEventListener("click", () => {
                root.closest("dialog")?.remove();
                PubSub.default.pub("executeCommand", "doc.open" as any);
            });
            root.replaceChildren(
                el("style", { textContent: CSS }),
                el("div", { className: "path", textContent: `Thư mục: ${j.folder}` }),
                list,
                el("div", { className: "row" }, openFolder, change, other),
            );
        };
        await render();
        PubSub.default.pub("showDialog", "command.project.open" as any, root, [{ content: "common.cancel" as any }]);
    }
}

@command({ key: "project.folder" as any, icon: "icon-Directory" })
export class OpenProjectFolderCommand implements ICommand {
    async execute(): Promise<void> {
        if (!(await localApi())) return noServer();
        const j = await apiJson("/api/open-folder", { method: "POST" });
        toast(`Đã mở thư mục ${j.folder}`);
    }
}
