// lib/stage-assets.ts
// Fork 十期: stage asset storage — portraits / CG / BGM blobs in IndexedDB.
// Assets NEVER enter LLM prompts; the KP only sees a one-page manifest (names) and outputs cue names.

import type { StageAsset } from "./map-types";

const DB_NAME = "AiPhoneMapAssets";
const STORE = "blobs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store a file blob under key `assetId`. */
export async function putAssetBlob(assetId: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, assetId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Read a blob → object URL (for <img>/<audio>). Caller should revoke when done. */
export async function getAssetUrl(assetId: string): Promise<string | null> {
  try {
    const db = await openDb();
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(assetId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

export async function deleteAssetBlob(assetId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(assetId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* ignore */ }
}

/** Register uploaded files as assets: auto-bind portraits by filename → NPC name match. */
export async function registerAssetFiles(
  worldId: string,
  files: File[],
  npcNames: string[],
  existing: StageAsset[],
): Promise<{ assets: StageAsset[]; skipped: string[] }> {
  const assets = [...existing];
  const skipped: string[] = [];
  let n = assets.length;
  for (const f of files) {
    const kind: StageAsset["kind"] | null = f.type.startsWith("image/")
      ? "portrait"
      : f.type.startsWith("audio/") ? "bgm" : null;
    // CG images are distinguished by filename prefix folder "cg/" or name starting with "cg"
    let isCg = /^(cg|CG)[_\-/]/.test(f.name);
    const audio = f.type.startsWith("audio/");
    if (audio && !kind) { skipped.push(f.name); continue; }
    if (!f.type.startsWith("image/") && !audio) { skipped.push(f.name); continue; }
    let name = f.name.replace(/\.[^.]+$/, "").replace(/^(cg|CG|npc|NPC|bgm|BGM)[_\-/]/, "");
    const asset: StageAsset = {
      id: `asset_${worldId}_${Date.now()}_${n++}`,
      kind: audio ? "bgm" : isCg ? "cg" : "portrait",
      name,
      boundTo: undefined,
      fileName: f.name,
    };
    if (asset.kind === "portrait") {
      // Fork fix: fuzzy bind — strip whitespace/parenthetical suffixes/job titles, then try
      // exact / substring both ways (extracted NPC names often carry suffixes the filename lacks)
      const normalize = (s: string) => s.replace(/[（(].*?[)）]/g, "").replace(/[\s·•・]/g, "");
      const nName = normalize(name);
      const hit = npcNames.find(nm => {
        const nNm = normalize(nm);
        if (!nNm || !nName) return false;
        return nNm === nName || nNm.includes(nName) || nName.includes(nNm);
      });
      if (hit) asset.boundTo = hit;
    }
    // Fork fix: one bad file must not sink the whole batch — skip on write failure
    try {
      await putAssetBlob(asset.id, f);
      assets.push(asset);
    } catch {
      skipped.push(f.name);
    }
  }
  return { assets, skipped };
}

/** Manifest for KP prompt: one page of names + usage hints. */
export function buildAssetManifest(assets: StageAsset[]): string {
  if (!assets.length) return "";
  const portraits = assets.filter(a => a.kind === "portrait").map(a => a.boundTo || a.name);
  const cgs = assets.filter(a => a.kind === "cg");
  const bgms = assets.filter(a => a.kind === "bgm");
  const lines: string[] = [];
  if (portraits.length) lines.push(`立绘（npc_lines.speaker 匹配名字时前端自动显示）：${portraits.join("、")}`);
  if (cgs.length) lines.push(`CG（重要场景在 cg 字段填资源名触发全屏展示）：${cgs.map(c => `${c.name}${c.note ? `(${c.note})` : ""}`).join("、")}`);
  if (bgms.length) lines.push(`BGM（氛围切换时在 bgm 字段填资源名）：${bgms.map(b => `${b.name}${b.note ? `(${b.note})` : ""}`).join("、")}`);
  return lines.join("\n");
}
