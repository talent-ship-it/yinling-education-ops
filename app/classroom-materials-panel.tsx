"use client";

import { ChevronRight, Download, FileText, Folder, Link, Plus, RefreshCw, Search, Upload, Users, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MaterialUploadResumeStore, materialUploadFingerprint, ResumableMaterialUpload, type MaterialUploadResumeRecord, type MaterialUploadSession } from "@/lib/classroom-materials-upload";
import styles from "./classroom-materials.module.css";

type Teacher = { id: string; name: string };
type Classroom = { bookingId: string; occurrenceId: string; sourceDate?: string };
type MaterialFolder = { id: string; parentId: string | null; name: string };
type Material = {
  id: string; folderId: string | null; title: string; kind: "file" | "link";
  mimeType: string; byteSize: number; status: "uploading" | "ready";
  canDownload?: boolean; createdAt: string;
};
type MaterialList = {
  configured: boolean; canManage: boolean; folders: MaterialFolder[]; materials: Material[];
  breadcrumbs: { id: string; name: string }[]; nextOffset: number | null; maxFileBytes?: number; error?: string; uploadScope?: string;
};
type GrantTarget = { targetType: "folder" | "material"; targetId: string; title: string };
type JobStatus = "queued" | "uploading" | "paused" | "completing" | "error" | "done";
type UploadJob = {
  id: string; file: File; folderId: string | null; mimeType: string; status: JobStatus; bytes: number;
  error?: string; materialId?: string; uploader?: ResumableMaterialUpload; uploaded?: boolean; controller?: AbortController;
  resume?: MaterialUploadResumeRecord; resumeStore?: MaterialUploadResumeStore;
};
type UploadRow = Pick<UploadJob, "id" | "status" | "bytes" | "error"> & { name: string; size: number; active: boolean };

const mimeTypes: Record<string, string> = {
  pdf: "application/pdf", ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp3: "audio/mpeg", wav: "audio/wav",
  m4a: "audio/mp4", ogg: "audio/ogg", mp4: "video/mp4",
};
const jobLabels: Record<JobStatus, string> = { queued: "等待上传", uploading: "上传中", paused: "已暂停", completing: "校验中", error: "上传失败", done: "已完成" };

async function request<T>(path = "", init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/classroom/materials${path}`, {
    ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `请求失败（${response.status}）`);
  return body as T;
}

function messageOf(error: unknown) { return error instanceof Error ? error.message : "操作失败，请重试"; }
function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function openUrl(value: string, popup: Window | null) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("教材链接无效");
  if (popup) popup.location.replace(url.href);
  else {
    const anchor = document.createElement("a");
    anchor.href = url.href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.click();
  }
}

function MaterialDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} className={styles.dialog} onCancel={(event) => { event.preventDefault(); close(); }}>
    <header><h3 id={titleId}>{title}</h3><button type="button" className={styles.iconButton} aria-label="关闭" onClick={close}><X size={18} /></button></header>
    {children}
  </dialog>;
}

function GrantDialog({ target, teachers, close, saved }: { target: GrantTarget; teachers: Teacher[]; close: () => void; saved: () => void }) {
  const [grants, setGrants] = useState<string[]>([]);
  const [downloads, setDownloads] = useState<string[]>([]);
  const [inherited, setInherited] = useState<{ teacherIds: string[]; downloadTeacherIds: string[] }>({ teacherIds: [], downloadTeacherIds: [] });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<{ teacherIds: string[]; downloadTeacherIds?: string[]; inheritedTeacherIds?: string[]; inheritedDownloadTeacherIds?: string[] }>(`/grants?${new URLSearchParams({ targetType: target.targetType, targetId: target.targetId })}`, { signal: controller.signal })
      .then((body) => { if (!controller.signal.aborted) { setGrants(body.teacherIds); setDownloads(body.downloadTeacherIds || []); setInherited({ teacherIds: body.inheritedTeacherIds || [], downloadTeacherIds: body.inheritedDownloadTeacherIds || [] }); setLoading(false); } })
      .catch((error) => { if (!controller.signal.aborted) { setError(messageOf(error)); setLoadFailed(true); setLoading(false); } });
    return () => controller.abort();
  }, [target]);
  const toggle = (teacherId: string, checked: boolean, download = false) => {
    if (download) {
      setDownloads((current) => checked ? [...new Set([...current, teacherId])] : current.filter((id) => id !== teacherId));
      if (checked) setGrants((current) => [...new Set([...current, teacherId])]);
    } else {
      setGrants((current) => checked ? [...new Set([...current, teacherId])] : current.filter((id) => id !== teacherId));
      if (!checked) setDownloads((current) => current.filter((id) => id !== teacherId));
    }
  };
  return <MaterialDialog title={`授权教师 · ${target.title}`} close={close}>
    <form onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try { await request("/grants", { method: "PUT", body: JSON.stringify({ targetType: target.targetType, targetId: target.targetId, teacherIds: grants, downloadTeacherIds: downloads }) }); saved(); }
      catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
    }}>
      <label className={styles.search}><Search size={16} /><input aria-label="搜索教师" placeholder="搜索教师" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className={styles.grantList}>
        <div className={styles.grantHeader}><span>教师</span><span>课堂使用</span><span>下载原件</span></div>
        {loading ? <p className={styles.empty}>正在加载授权…</p> : teachers.filter((teacher) => teacher.name.toLowerCase().includes(query.toLowerCase())).map((teacher) => <div className={styles.grantRow} key={teacher.id}>
          <span>{teacher.name}</span>
          <label className={styles.grantCheck}><input type="checkbox" aria-label={`${teacher.name} 课堂使用`} checked={grants.includes(teacher.id) || inherited.teacherIds.includes(teacher.id)} onChange={(event) => toggle(teacher.id, event.target.checked)} disabled={busy || loadFailed || inherited.teacherIds.includes(teacher.id)} />{inherited.teacherIds.includes(teacher.id) && <small>继承</small>}</label>
          <label className={styles.grantCheck}><input type="checkbox" aria-label={`${teacher.name} 下载原件`} checked={downloads.includes(teacher.id) || inherited.downloadTeacherIds.includes(teacher.id)} onChange={(event) => toggle(teacher.id, event.target.checked, true)} disabled={busy || loadFailed || inherited.downloadTeacherIds.includes(teacher.id)} />{inherited.downloadTeacherIds.includes(teacher.id) && <small>继承</small>}</label>
        </div>)}
        {!loading && teachers.length === 0 && <p className={styles.empty}>暂无教师</p>}
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <footer><button type="button" className={styles.secondary} onClick={close}>取消</button><button className={styles.primary} disabled={loading || busy || loadFailed}>{busy ? "保存中…" : "确认授权"}</button></footer>
    </form>
  </MaterialDialog>;
}

export default function ClassroomMaterialsPanel({ teachers, selectedClassroom, notify }: {
  teachers: Teacher[]; selectedClassroom?: Classroom; notify?: (message: string) => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<{ key: string; data?: MaterialList; error?: string }>({ key: "" });
  const [moreBusy, setMoreBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [modal, setModal] = useState<"folder" | "link" | null>(null);
  const [grantTarget, setGrantTarget] = useState<GrantTarget | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formError, setFormError] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const jobs = useRef<UploadJob[]>([]);
  const activeJob = useRef<string | null>(null);
  const mounted = useRef(true);
  const key = `${folderId || "root"}:${search}:${revision}`;
  const loading = view.key !== key;
  const data = !loading ? view.data : undefined;
  const canManage = !!data?.canManage;
  const canUpload = canManage && !!data?.configured;
  const params = (offset = 0) => new URLSearchParams({ folderId: folderId || "root", q: search, offset: String(offset), limit: "100" });
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ folderId: folderId || "root", q: search, offset: "0", limit: "100" });
    void request<MaterialList>(`?${params}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setView({ key, data }); })
      .catch((error) => { if (!controller.signal.aborted) setView({ key, error: messageOf(error) }); });
    return () => controller.abort();
  }, [folderId, search, key]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; jobs.current.forEach((job) => job.controller?.abort()); };
  }, []);
  const syncJobs = () => {
    if (mounted.current) setUploadRows(jobs.current.map((job) => ({ id: job.id, name: job.file.name, size: job.file.size, status: job.status, bytes: job.bytes, error: job.error, active: activeJob.current === job.id })));
  };
  const runNext = async () => {
    if (activeJob.current || !mounted.current) return;
    const job = jobs.current.find((entry) => entry.status === "queued");
    if (!job) return;
    activeJob.current = job.id;
    job.controller = new AbortController(); job.status = job.uploaded ? "completing" : "uploading"; job.error = undefined; syncJobs();
    const signal = job.controller.signal;
    try {
      let ready = false;
      if (!job.uploaded) {
        const result = await request<{ material: Material; upload: MaterialUploadSession | null }>("/upload", {
          method: "POST", signal, body: JSON.stringify({ folderId: job.folderId, title: job.file.name, fileName: job.file.name, mimeType: job.mimeType, byteSize: job.file.size, requestKey: job.id }),
        });
        if (job.resume?.materialId && job.resume.materialId !== result.material.id) throw new Error("待续传文件记录不匹配");
        job.materialId = result.material.id;
        ready = result.material.status === "ready";
        if (!ready && !job.resume?.uploaded) {
          if (!result.upload) throw new Error("未能获取教材上传地址");
          if (job.uploader) job.uploader.refreshSession(result.upload);
          else {
            job.uploader = new ResumableMaterialUpload(job.file, result.upload, job.mimeType);
            if (job.resume?.upload) job.uploader.restore(job.resume.upload);
          }
          await job.uploader.run(signal, (bytes) => {
            job.bytes = bytes;
            if (job.resume) { job.resume = { ...job.resume, materialId: job.materialId, upload: job.uploader?.checkpoint(), uploaded: bytes === job.file.size }; job.resumeStore?.save(job.resume); }
            syncJobs();
          });
        }
        signal.throwIfAborted(); job.uploaded = true;
      }
      job.status = "completing"; syncJobs();
      if (!ready) await request(`/${job.materialId}/complete`, { method: "POST", signal });
      job.status = "done"; job.bytes = job.file.size;
      if (job.resume) job.resumeStore?.remove(job.resume.fingerprint);
      if (mounted.current) setRevision((value) => value + 1);
    } catch (error) {
      if (signal.aborted) job.status = "paused";
      else { job.status = "error"; job.error = messageOf(error); }
    } finally {
      activeJob.current = null; job.controller = undefined; syncJobs();
      void runNext();
    }
  };
  const queueFiles = async (files: FileList | File[]) => {
    if (!canUpload) return;
    setActionError("");
    const errors: string[] = [];
    const targetFolder = folderId;
    let resumeStore: MaterialUploadResumeStore | undefined;
    try { resumeStore = new MaterialUploadResumeStore(data?.uploadScope, window.sessionStorage); } catch { }
    for (const file of Array.from(files)) {
      const extension = file.name.split(".").at(-1)?.toLowerCase() || "";
      if (!mimeTypes[extension]) { errors.push(`${file.name}：不支持的文件类型`); continue; }
      if (file.size === 0) { errors.push(`${file.name}：文件为空`); continue; }
      if (data?.maxFileBytes && file.size > data.maxFileBytes) { errors.push(`${file.name}：超过 ${sizeLabel(data.maxFileBytes)}`); continue; }
      if (jobs.current.some((job) => job.status !== "done" && job.folderId === targetFolder && job.file.name === file.name && job.file.size === file.size && job.file.lastModified === file.lastModified)) continue;
      try {
        const fingerprint = await materialUploadFingerprint(file, targetFolder);
        if (!mounted.current) return;
        const resume = resumeStore?.get(fingerprint) || { fingerprint, requestKey: crypto.randomUUID(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
        if (jobs.current.some((job) => job.status !== "done" && job.resume?.fingerprint === fingerprint)) continue;
        resumeStore?.save(resume);
        jobs.current.push({ id: resume.requestKey, file, folderId: targetFolder, mimeType: mimeTypes[extension], status: "queued", bytes: 0, resume, resumeStore });
        syncJobs(); void runNext();
      } catch { errors.push(`${file.name}：无法读取文件`); }
    }
    setActionError(errors.join("；")); syncJobs(); void runNext();
  };
  const actOnMaterial = async (material: Material, present: boolean) => {
    const popup = (!present || material.kind === "link" || /^(audio|video)\//.test(material.mimeType)) ? window.open("", "_blank") : null;
    if (popup) popup.opener = null;
    setActionBusy(material.id); setActionError("");
    try {
      const result = await request<{ url?: string; mode?: string }>(`/${material.id}/${present ? "present" : "download"}`, {
        method: "POST", body: present ? JSON.stringify(selectedClassroom) : undefined,
      });
      if (result.url) openUrl(result.url, popup);
      else { popup?.close(); notify?.("教材已提交到课堂"); }
    } catch (error) { popup?.close(); setActionError(messageOf(error)); }
    finally { setActionBusy(""); }
  };
  return <section className={`${styles.panel} ${dragging ? styles.dragging : ""}`} aria-label="教材资料库"
    onDragOver={(event) => { if (canUpload && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); void queueFiles(event.dataTransfer.files); }}>
    <header className={styles.heading}><h2><Folder size={21} />资料库</h2><button type="button" className={styles.iconButton} aria-label="刷新资料库" onClick={() => setRevision((value) => value + 1)} disabled={loading}><RefreshCw size={16} /></button></header>
    <div className={styles.toolbar}>
      {canManage && <><button type="button" className={styles.secondary} onClick={() => { setFormTitle(""); setFormError(""); setModal("folder"); }}><Plus size={16} />新建文件夹</button>
        <button type="button" className={styles.primary} disabled={!canUpload} onClick={() => input.current?.click()}><Upload size={16} />上传</button>
        <button type="button" className={styles.secondary} onClick={() => { setFormTitle(""); setFormUrl(""); setFormError(""); setModal("link"); }}><Link size={16} />添加链接</button>
        <input ref={input} className={styles.hidden} type="file" multiple accept={Object.keys(mimeTypes).map((extension) => `.${extension}`).join(",")} onChange={(event) => { if (event.target.files) void queueFiles(Array.from(event.target.files)); event.target.value = ""; }} /></>}
      <form className={styles.search} onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }}><Search size={16} /><input aria-label="搜索教材" placeholder="搜索教材" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="submit" className={styles.searchButton}>搜索</button></form>
    </div>
    <nav className={styles.breadcrumbs} aria-label="教材目录"><button type="button" onClick={() => { setFolderId(null); setSearch(""); setQuery(""); }}>学校资料</button>{data?.breadcrumbs.map((folder) => <span key={folder.id}><ChevronRight size={14} /><button type="button" onClick={() => { setFolderId(folder.id); setSearch(""); setQuery(""); }}>{folder.name}</button></span>)}</nav>
    {(view.error && !loading) || (data && !data.configured) ? <p role="alert" className={styles.error}>{view.error || data?.error || "教材库尚未配置存储服务"}</p> : null}
    {actionError && <p role="alert" className={styles.error}>{actionError}</p>}
    <div className={styles.list} aria-busy={loading}>
      <div className={styles.listHeader}><span>名称</span><span>大小</span><span>操作</span></div>
      {loading ? <p className={styles.empty}>正在加载教材…</p> : data && <>
        {data.folders.map((folder) => <div className={styles.row} key={`folder:${folder.id}`}>
          <button type="button" className={styles.fileName} onClick={() => { setFolderId(folder.id); setSearch(""); setQuery(""); }}><Folder className={styles.folderIcon} size={25} fill="currentColor" /><span>{folder.name}</span></button><span className={styles.size}>—</span>
          <div className={styles.actions}>{canManage && <button type="button" onClick={() => setGrantTarget({ targetType: "folder", targetId: folder.id, title: folder.name })}><Users size={15} />授权</button>}</div>
        </div>)}
        {data.materials.map((material) => <div className={styles.row} key={material.id}>
          <div className={styles.fileName}>{material.kind === "link" ? <Link size={22} /> : <FileText size={23} />}<span>{material.title}{material.status !== "ready" && <small>上传未完成</small>}</span></div><span className={styles.size}>{material.kind === "link" ? "链接" : sizeLabel(material.byteSize)}</span>
          <div className={styles.actions}>
            <button type="button" disabled={material.status !== "ready" || !selectedClassroom || !!actionBusy} onClick={() => void actOnMaterial(material, true)}>课堂使用</button>
            {(material.kind === "link" || material.canDownload) && <button type="button" disabled={material.status !== "ready" || !!actionBusy} onClick={() => void actOnMaterial(material, false)}><Download size={14} />{material.kind === "link" ? "打开链接" : "下载"}</button>}
            {canManage && <button type="button" onClick={() => setGrantTarget({ targetType: "material", targetId: material.id, title: material.title })}><Users size={15} />授权</button>}
          </div>
        </div>)}
        {!data.folders.length && !data.materials.length && <p className={styles.empty}>{search ? "没有找到教材" : "暂无教材"}</p>}
      </>}
    </div>
    {data?.nextOffset != null && <button type="button" className={styles.loadMore} disabled={moreBusy} onClick={async () => {
      setMoreBusy(true); setActionError(""); const currentKey = key;
      try { const next = await request<MaterialList>(`?${params(data.nextOffset ?? 0)}`); setView((current) => current.key !== currentKey || !current.data ? current : ({ key: currentKey, data: { ...next, folders: [...current.data.folders, ...next.folders].filter((entry, index, all) => all.findIndex((value) => value.id === entry.id) === index), materials: [...current.data.materials, ...next.materials].filter((entry, index, all) => all.findIndex((value) => value.id === entry.id) === index) } })); }
      catch (error) { setActionError(messageOf(error)); } finally { setMoreBusy(false); }
    }}>{moreBusy ? "加载中…" : "加载更多"}</button>}
    {uploadRows.length > 0 && <section className={styles.uploads} aria-label="上传队列"><header><h3>上传队列</h3><button type="button" onClick={() => { jobs.current = jobs.current.filter((job) => job.status !== "done"); syncJobs(); }}>清除已完成</button></header>{uploadRows.map((row) => <div className={styles.uploadRow} key={row.id}>
      <div><strong>{row.name}</strong><small>{jobLabels[row.status]} · {sizeLabel(row.bytes)} / {sizeLabel(row.size)}</small><progress max={row.size} value={row.bytes} aria-label={`${row.name} 上传进度`} />{row.error && <span role="alert" className={styles.error}>{row.error}</span>}</div>
      {(row.status === "uploading" || row.status === "queued") && <button type="button" onClick={() => { const job = jobs.current.find((entry) => entry.id === row.id); if (job) { job.status = "paused"; job.controller?.abort(); syncJobs(); } }}>暂停</button>}
      {(row.status === "error" || row.status === "paused") && <button type="button" disabled={row.active} onClick={() => { const job = jobs.current.find((entry) => entry.id === row.id); if (job) { job.status = "queued"; syncJobs(); void runNext(); } }}>{row.status === "error" ? "重试" : "继续"}</button>}
    </div>)}</section>}
    {modal && <MaterialDialog title={modal === "folder" ? "新建文件夹" : "添加教材链接"} close={() => setModal(null)}><form onSubmit={async (event) => {
      event.preventDefault(); setFormBusy(true); setFormError("");
      try { await request("", { method: "POST", body: JSON.stringify(modal === "folder" ? { action: "create-folder", parentId: folderId, name: formTitle.trim() } : { action: "create-link", folderId, title: formTitle.trim(), sourceUrl: formUrl.trim() }) }); setModal(null); setRevision((value) => value + 1); }
      catch (error) { setFormError(messageOf(error)); } finally { setFormBusy(false); }
    }}><label className={styles.field}>名称<input required autoFocus maxLength={200} value={formTitle} onChange={(event) => setFormTitle(event.target.value)} /></label>{modal === "link" && <label className={styles.field}>教材链接<input required type="url" value={formUrl} onChange={(event) => setFormUrl(event.target.value)} /></label>}{formError && <p role="alert" className={styles.error}>{formError}</p>}<footer><button type="button" className={styles.secondary} onClick={() => setModal(null)}>取消</button><button className={styles.primary} disabled={formBusy || !formTitle.trim()}>{formBusy ? "保存中…" : "保存"}</button></footer></form></MaterialDialog>}
    {grantTarget && <GrantDialog target={grantTarget} teachers={teachers} close={() => setGrantTarget(null)} saved={() => { setGrantTarget(null); setRevision((value) => value + 1); notify?.("教师授权已保存"); }} />}
  </section>;
}
