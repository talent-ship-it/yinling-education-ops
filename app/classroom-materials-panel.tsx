"use client";

import { ChevronRight, Download, FileText, Folder, Link, Plus, RefreshCw, Search, Upload, Users, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createMaterialUploadFolderResolver, materialDropFiles, MaterialUploadResumeStore, materialUploadFingerprint, ResumableMaterialUpload, type MaterialUploadResumeRecord, type MaterialUploadSession } from "@/lib/classroom-materials-upload";
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
  configured: boolean; canManage: boolean; canPresent: boolean; folders: MaterialFolder[]; materials: Material[];
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
  const url = materialUrl(value);
  if (popup) popup.location.replace(url.href);
  else {
    const anchor = document.createElement("a");
    anchor.href = url.href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.click();
  }
}

function materialUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("教材链接无效");
  return url;
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

type GrantValues = { teacherIds: string[]; downloadTeacherIds: string[] };

function GrantCheckbox({ name, label, checked, inherited, disabled, toggle }: {
  name: string; label: string; checked: boolean; inherited: boolean; disabled: boolean; toggle: (checked: boolean) => void;
}) {
  return <label className={styles.grantCheck}><input type="checkbox" aria-label={`${name} ${label}直接授权`} checked={checked} onChange={(event) => toggle(event.target.checked)} disabled={disabled} />{inherited && <small>上级已授权</small>}</label>;
}

function GrantTeacherRow({ teacher, grants, downloads, inherited, disabled, toggle }: {
  teacher: Teacher; grants: string[]; downloads: string[]; inherited: GrantValues; disabled: boolean; toggle: (id: string, checked: boolean, download?: boolean) => void;
}) {
  return <div className={styles.grantRow}>
    <span>{teacher.name}</span>
    <GrantCheckbox name={teacher.name} label="课堂使用" checked={grants.includes(teacher.id)} inherited={inherited.teacherIds.includes(teacher.id)} disabled={disabled} toggle={(checked) => toggle(teacher.id, checked)} />
    <GrantCheckbox name={teacher.name} label="下载原件" checked={downloads.includes(teacher.id)} inherited={inherited.downloadTeacherIds.includes(teacher.id)} disabled={disabled} toggle={(checked) => toggle(teacher.id, checked, true)} />
  </div>;
}

function GrantTeacherRows({ teachers, loading, query, ...rowProps }: {
  teachers: Teacher[]; loading: boolean; query: string;
} & Omit<Parameters<typeof GrantTeacherRow>[0], "teacher">) {
  if (loading) return <p className={styles.empty}>正在加载授权…</p>;
  if (!teachers.length) return <p className={styles.empty}>暂无教师</p>;
  return teachers.filter((teacher) => teacher.name.toLowerCase().includes(query.toLowerCase())).map((teacher) => <GrantTeacherRow key={teacher.id} teacher={teacher} {...rowProps} />);
}

function grantDisabled(loading: boolean, busy: boolean, loadFailed: boolean) { return loading || busy || loadFailed; }
function grantIds(ids?: string[]) { return ids || []; }

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
      .then((body) => { if (!controller.signal.aborted) { setGrants(body.teacherIds); setDownloads(grantIds(body.downloadTeacherIds)); setInherited({ teacherIds: grantIds(body.inheritedTeacherIds), downloadTeacherIds: grantIds(body.inheritedDownloadTeacherIds) }); setLoading(false); } })
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
        <GrantTeacherRows teachers={teachers} query={query} loading={loading} grants={grants} downloads={downloads} inherited={inherited} disabled={grantDisabled(false, busy, loadFailed)} toggle={toggle} />
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <footer><button type="button" className={styles.secondary} onClick={close}>取消</button><button className={styles.primary} disabled={grantDisabled(loading, busy, loadFailed)}>{busy ? "保存中…" : "确认授权"}</button></footer>
    </form>
  </MaterialDialog>;
}

function nextUploadJob(jobs: UploadJob[], active: string | null, mounted: boolean) {
  if (active || !mounted) return;
  return jobs.find((job) => job.status === "queued");
}

async function reserveUploadJob(job: UploadJob, signal: AbortSignal) {
  const result = await request<{ material: Material; upload: MaterialUploadSession | null }>("/upload", {
    method: "POST", signal, body: JSON.stringify({ folderId: job.folderId, title: job.file.name, fileName: job.file.name, mimeType: job.mimeType, byteSize: job.file.size, requestKey: job.id }),
  });
  if (job.resume?.materialId && job.resume.materialId !== result.material.id) throw new Error("待续传文件记录不匹配");
  job.materialId = result.material.id;
  return result;
}

function newJobUploader(job: UploadJob, session: MaterialUploadSession) {
  const uploader = new ResumableMaterialUpload(job.file, session, job.mimeType);
  if (job.resume?.upload) uploader.restore(job.resume.upload);
  return uploader;
}

function prepareJobUploader(job: UploadJob, session: MaterialUploadSession | null) {
  if (!session) throw new Error("未能获取教材上传地址");
  if (job.uploader) job.uploader.refreshSession(session);
  else job.uploader = newJobUploader(job, session);
  return job.uploader;
}

function saveUploadProgress(job: UploadJob, bytes: number) {
  job.bytes = bytes;
  if (job.resume) {
    job.resume = { ...job.resume, materialId: job.materialId, upload: job.uploader?.checkpoint(), uploaded: bytes === job.file.size };
    job.resumeStore?.save(job.resume);
  }
}

async function uploadReservedJob(job: UploadJob, result: Awaited<ReturnType<typeof reserveUploadJob>>, signal: AbortSignal, publish: () => void) {
  if (result.material.status === "ready") return true;
  if (job.resume?.uploaded) return false;
  const uploader = prepareJobUploader(job, result.upload);
  await uploader.run(signal, (bytes) => { saveUploadProgress(job, bytes); publish(); });
  return false;
}

function completeUploadJob(job: UploadJob) {
  job.status = "done"; job.bytes = job.file.size;
  if (job.resume) job.resumeStore?.remove(job.resume.fingerprint);
}

async function processUploadJob(job: UploadJob, signal: AbortSignal, publish: () => void) {
  let ready = false;
  if (!job.uploaded) {
    ready = await uploadReservedJob(job, await reserveUploadJob(job, signal), signal, publish);
    signal.throwIfAborted(); job.uploaded = true;
  }
  job.status = "completing"; publish();
  if (!ready) await request(`/${job.materialId}/complete`, { method: "POST", signal });
  completeUploadJob(job);
}

function recordUploadFailure(job: UploadJob, error: unknown, signal: AbortSignal) {
  if (signal.aborted) job.status = "paused";
  else { job.status = "error"; job.error = messageOf(error); }
}

type FilePreparation = {
  jobs: { current: UploadJob[] }; mounted: { current: boolean }; resolveFolder: (file: File) => Promise<string | null>;
  maxFileBytes?: number; resumeStore?: MaterialUploadResumeStore; syncJobs: () => void; runNext: () => Promise<void>;
};

function uploadFileMime(file: File) {
  const extension = file.name.split(".").at(-1)?.toLowerCase() || "";
  if (!mimeTypes[extension]) throw new Error("不支持的文件类型");
  return mimeTypes[extension];
}

function validateUploadSize(file: File, maxBytes?: number) {
  if (file.size === 0) throw new Error("文件为空");
  if (maxBytes && file.size > maxBytes) throw new Error("超过 " + sizeLabel(maxBytes));
}

function sameUploadFile(first: File, second: File) {
  return first.name === second.name && first.size === second.size && first.lastModified === second.lastModified;
}

function hasPendingFile(jobs: UploadJob[], file: File, folderId: string | null) {
  return jobs.filter((job) => job.status !== "done").some((job) => job.folderId === folderId && sameUploadFile(job.file, file));
}

function cannotQueueFile(preparation: FilePreparation, file: File, folderId: string | null) {
  return !preparation.mounted.current || hasPendingFile(preparation.jobs.current, file, folderId);
}

function hasPendingFingerprint(jobs: UploadJob[], fingerprint: string) {
  return jobs.some((job) => job.status !== "done" && job.resume?.fingerprint === fingerprint);
}

function resumeForFile(store: MaterialUploadResumeStore | undefined, fingerprint: string) {
  return store?.get(fingerprint) || { fingerprint, requestKey: crypto.randomUUID(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
}

function uploadResumeStore(scope?: string) {
  try { return new MaterialUploadResumeStore(scope, window.sessionStorage); } catch { return undefined; }
}

async function fileFingerprint(file: File, folderId: string | null) {
  try { return await materialUploadFingerprint(file, folderId); } catch { throw new Error("无法读取文件"); }
}

function enqueuePreparedFile(file: File, folderId: string | null, mimeType: string, resume: MaterialUploadResumeRecord, preparation: FilePreparation) {
  preparation.resumeStore?.save(resume);
  preparation.jobs.current.push({ id: resume.requestKey, file, folderId, mimeType, status: "queued", bytes: 0, resume, resumeStore: preparation.resumeStore });
  preparation.syncJobs(); void preparation.runNext();
}

async function prepareQueuedFile(file: File, preparation: FilePreparation) {
  const mimeType = uploadFileMime(file);
  validateUploadSize(file, preparation.maxFileBytes);
  const targetFolder = await preparation.resolveFolder(file);
  if (cannotQueueFile(preparation, file, targetFolder)) return;
  const fingerprint = await fileFingerprint(file, targetFolder);
  if (!preparation.mounted.current) return;
  const resume = resumeForFile(preparation.resumeStore, fingerprint);
  if (hasPendingFingerprint(preparation.jobs.current, fingerprint)) return;
  enqueuePreparedFile(file, targetFolder, mimeType, resume, preparation);
}

function uploadFailureLabel(file: File, error: unknown) {
  return (file.webkitRelativePath || file.name) + "：" + messageOf(error);
}

async function collectUploadFiles(files: File[], prepare: (file: File) => Promise<void>, signal: AbortSignal) {
  const errors: string[] = [];
  for (const file of files) {
    try { await prepare(file); }
    catch (error) { if (signal.aborted) return errors; errors.push(uploadFailureLabel(file, error)); }
  }
  return errors;
}

function uploadRow(job: UploadJob, active: string | null): UploadRow {
  return { id: job.id, name: job.file.webkitRelativePath || job.file.name, size: job.file.size, status: job.status, bytes: job.bytes, error: job.error, active: active === job.id };
}

function refreshMounted(mounted: { current: boolean }, refresh: () => void) { if (mounted.current) refresh(); }
function abortUploadJobs(jobs: { current: UploadJob[] }) { jobs.current.forEach((job) => job.controller?.abort()); }

function useMaterialUploadJobs(refresh: () => void) {
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const jobs = useRef<UploadJob[]>([]);
  const activeJob = useRef<string | null>(null);
  const mounted = useRef(true);
  const directoryRequests = useRef(new Set<AbortController>());
  useEffect(() => {
    mounted.current = true;
    const pendingDirectories = directoryRequests.current;
    return () => { mounted.current = false; abortUploadJobs(jobs); pendingDirectories.forEach((controller) => controller.abort()); };
  }, []);
  const syncJobs = () => { if (mounted.current) setUploadRows(jobs.current.map((job) => uploadRow(job, activeJob.current))); };
  const runNext = async () => {
    const job = nextUploadJob(jobs.current, activeJob.current, mounted.current);
    if (!job) return;
    activeJob.current = job.id;
    job.controller = new AbortController(); job.status = job.uploaded ? "completing" : "uploading"; job.error = undefined; syncJobs();
    const signal = job.controller.signal;
    try { await processUploadJob(job, signal, syncJobs); refreshMounted(mounted, refresh); }
    catch (error) { recordUploadFailure(job, error, signal); }
    finally { activeJob.current = null; job.controller = undefined; syncJobs(); void runNext(); }
  };
  return { jobs, mounted, directoryRequests, syncJobs, runNext, uploadRows };
}

function useMaterialFileQueue(settings: { folderId: string | null; data: MaterialList | undefined; canUpload: boolean; refresh: () => void; setError: (message: string) => void }, queue: ReturnType<typeof useMaterialUploadJobs>) {
  const data = settings.data || { breadcrumbs: [], maxFileBytes: undefined, uploadScope: undefined };
  const { jobs, mounted, directoryRequests, syncJobs, runNext } = queue;
  return async (files: FileList | File[]) => {
    if (!settings.canUpload) return;
    settings.setError("");
    const directoryController = new AbortController();
    directoryRequests.current.add(directoryController);
    let directoryCreated = false;
    const resolveFolder = createMaterialUploadFolderResolver(settings.folderId, async (parentId, name) => {
      directoryController.signal.throwIfAborted();
      const result = await request<{ folder: MaterialFolder }>("", { method: "POST", signal: directoryController.signal, body: JSON.stringify({ action: "create-folder", parentId, name }) });
      directoryCreated = true;
      return result.folder.id;
    }, data.breadcrumbs.length);
    const preparation = { jobs, mounted, resolveFolder, maxFileBytes: data.maxFileBytes, resumeStore: uploadResumeStore(data.uploadScope), syncJobs, runNext };
    try {
      const errors = await collectUploadFiles(Array.from(files), (file) => prepareQueuedFile(file, preparation), directoryController.signal);
      if (!mounted.current) return;
      if (directoryCreated) settings.refresh();
      settings.setError(errors.join("；")); syncJobs(); void runNext();
    } finally { directoryRequests.current.delete(directoryController); }
  };
}

type MaterialView = { key: string; data?: MaterialList; error?: string };

function useMaterialNavigation() {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const browse = (id: string | null) => { setFolderId(id); setSearch(""); setQuery(""); };
  return { folderId, query, setQuery, search, setSearch, revision, browse, refresh: () => setRevision((value) => value + 1) };
}

function materialListParams(folderId: string | null, search: string, offset = 0) {
  return new URLSearchParams({ folderId: folderId || "root", q: search, offset: String(offset), limit: "100" });
}

function uniqueRows<T extends { id: string }>(items: T[]) {
  return items.filter((entry, index, all) => all.findIndex((value) => value.id === entry.id) === index);
}

function mergeMaterialPage(current: MaterialView, key: string, next: MaterialList): MaterialView {
  if (current.key !== key || !current.data) return current;
  return { key, data: { ...next, folders: uniqueRows([...current.data.folders, ...next.folders]), materials: uniqueRows([...current.data.materials, ...next.materials]) } };
}

function useMaterialListing(navigation: ReturnType<typeof useMaterialNavigation>, setError: (message: string) => void) {
  const { folderId, search, revision } = navigation;
  const [view, setView] = useState<MaterialView>({ key: "" });
  const [moreBusy, setMoreBusy] = useState(false);
  const key = (folderId || "root") + ":" + search + ":" + revision;
  useEffect(() => {
    const controller = new AbortController();
    void request<MaterialList>("?" + materialListParams(folderId, search), { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setView({ key, data }); })
      .catch((error) => { if (!controller.signal.aborted) setView({ key, error: messageOf(error) }); });
    return () => controller.abort();
  }, [folderId, search, key]);
  const more = async () => {
    setMoreBusy(true); setError("");
    const offset = view.data?.nextOffset ?? 0;
    try {
      const next = await request<MaterialList>("?" + materialListParams(folderId, search, offset));
      setView((current) => mergeMaterialPage(current, key, next));
    } catch (error) { setError(messageOf(error)); } finally { setMoreBusy(false); }
  };
  const loading = view.key !== key;
  return { loading, data: loading ? undefined : view.data, error: loading ? undefined : view.error, moreBusy, more };
}

type MaterialInteractions = { canManage: boolean; canPresent: boolean; selectedClassroom?: Classroom; busy: string; act: (material: Material, present: boolean) => void; grant: (target: GrantTarget) => void };
function materialActionDisabled(material: Material, busy: string) { return material.status !== "ready" || !!busy; }
function materialCanDownload(material: Material) { return material.kind === "link" || !!material.canDownload; }
function PresentMaterialAction({ material, interaction }: { material: Material; interaction: MaterialInteractions }) {
  return <button type="button" disabled={materialActionDisabled(material, interaction.busy) || !interaction.selectedClassroom} onClick={() => interaction.act(material, true)}>课堂使用</button>;
}
function DownloadMaterialAction({ material, interaction }: { material: Material; interaction: MaterialInteractions }) {
  return <button type="button" disabled={materialActionDisabled(material, interaction.busy)} onClick={() => interaction.act(material, false)}><Download size={14} />{material.kind === "link" ? "打开链接" : "下载"}</button>;
}
function MaterialActions({ material, interaction }: { material: Material; interaction: MaterialInteractions }) {
  return <div className={styles.actions}>
    {interaction.canPresent && <PresentMaterialAction material={material} interaction={interaction} />}
    {materialCanDownload(material) && <DownloadMaterialAction material={material} interaction={interaction} />}
    {interaction.canManage && <button type="button" onClick={() => interaction.grant({ targetType: "material", targetId: material.id, title: material.title })}><Users size={15} />授权</button>}
  </div>;
}
function MaterialTitle({ material }: { material: Material }) {
  return <span>{material.title}{material.status !== "ready" && <small>上传未完成</small>}</span>;
}
function MaterialRow({ material, interaction }: { material: Material; interaction: MaterialInteractions }) {
  return <div className={styles.row}>
    <div className={styles.fileName}>{material.kind === "link" ? <Link size={22} /> : <FileText size={23} />}<MaterialTitle material={material} /></div>
    <span className={styles.size}>{material.kind === "link" ? "链接" : sizeLabel(material.byteSize)}</span><MaterialActions material={material} interaction={interaction} />
  </div>;
}
function MaterialFolderRow({ folder, canManage, browse, grant }: { folder: MaterialFolder; canManage: boolean; browse: (id: string) => void; grant: (target: GrantTarget) => void }) {
  return <div className={styles.row}>
    <button type="button" className={styles.fileName} onClick={() => browse(folder.id)}><Folder className={styles.folderIcon} size={25} fill="currentColor" /><span>{folder.name}</span></button><span className={styles.size}>—</span>
    <div className={styles.actions}>{canManage && <button type="button" onClick={() => grant({ targetType: "folder", targetId: folder.id, title: folder.name })}><Users size={15} />授权</button>}</div>
  </div>;
}
function EmptyMaterialList({ data, search }: { data: MaterialList; search: string }) {
  if (data.folders.length || data.materials.length) return null;
  return <p className={styles.empty}>{search ? "没有找到教材" : "暂无教材"}</p>;
}
function MaterialListRows({ data, navigation, interaction }: { data: MaterialList; navigation: ReturnType<typeof useMaterialNavigation>; interaction: MaterialInteractions }) {
  return <>
    {data.folders.map((folder) => <MaterialFolderRow key={folder.id} folder={folder} canManage={interaction.canManage} browse={navigation.browse} grant={interaction.grant} />)}
    {data.materials.map((material) => <MaterialRow key={material.id} material={material} interaction={interaction} />)}
    <EmptyMaterialList data={data} search={navigation.search} />
  </>;
}
function MaterialListBody({ listing, navigation, interaction }: { listing: ReturnType<typeof useMaterialListing>; navigation: ReturnType<typeof useMaterialNavigation>; interaction: MaterialInteractions }) {
  if (listing.loading) return <p className={styles.empty}>正在加载教材…</p>;
  if (!listing.data) return null;
  return <MaterialListRows data={listing.data} navigation={navigation} interaction={interaction} />;
}
function MoreMaterials({ listing }: { listing: ReturnType<typeof useMaterialListing> }) {
  if (listing.data?.nextOffset == null) return null;
  return <button type="button" className={styles.loadMore} disabled={listing.moreBusy} onClick={() => void listing.more()}>{listing.moreBusy ? "加载中…" : "加载更多"}</button>;
}

type UploadControls = { rows: UploadRow[]; pause: (id: string) => void; resume: (id: string) => void; clear: () => void };
function PauseUpload({ row, pause }: { row: UploadRow; pause: (id: string) => void }) {
  if (!["uploading", "queued"].includes(row.status)) return null;
  return <button type="button" onClick={() => pause(row.id)}>暂停</button>;
}
function ResumeUpload({ row, resume }: { row: UploadRow; resume: (id: string) => void }) {
  if (!["error", "paused"].includes(row.status)) return null;
  return <button type="button" disabled={row.active} onClick={() => resume(row.id)}>{row.status === "error" ? "重试" : "继续"}</button>;
}
function UploadQueueRow({ row, uploads }: { row: UploadRow; uploads: UploadControls }) {
  return <div className={styles.uploadRow}>
    <div><strong>{row.name}</strong><small>{jobLabels[row.status]} · {sizeLabel(row.bytes)} / {sizeLabel(row.size)}</small><progress max={row.size} value={row.bytes} aria-label={row.name + " 上传进度"} />{row.error && <span role="alert" className={styles.error}>{row.error}</span>}</div>
    <PauseUpload row={row} pause={uploads.pause} /><ResumeUpload row={row} resume={uploads.resume} />
  </div>;
}
function UploadQueue({ uploads }: { uploads: UploadControls }) {
  if (!uploads.rows.length) return null;
  return <section className={styles.uploads} aria-label="上传队列"><header><h3>上传队列</h3><button type="button" onClick={uploads.clear}>清除已完成</button></header>{uploads.rows.map((row) => <UploadQueueRow key={row.id} row={row} uploads={uploads} />)}</section>;
}
function pauseUploadJob(queue: ReturnType<typeof useMaterialUploadJobs>, id: string) {
  const job = queue.jobs.current.find((entry) => entry.id === id);
  if (job) { job.status = "paused"; job.controller?.abort(); queue.syncJobs(); }
}
function resumeUploadJob(queue: ReturnType<typeof useMaterialUploadJobs>, id: string) {
  const job = queue.jobs.current.find((entry) => entry.id === id);
  if (job) { job.status = "queued"; queue.syncJobs(); void queue.runNext(); }
}
function clearCompletedUploads(queue: ReturnType<typeof useMaterialUploadJobs>) {
  queue.jobs.current = queue.jobs.current.filter((job) => job.status !== "done"); queue.syncJobs();
}

function shouldOpenPopup(material: Material, present: boolean) {
  return !present || material.kind === "link" || /^(audio|video)\//.test(material.mimeType);
}
function materialPopup(material: Material, present: boolean) {
  const popup = shouldOpenPopup(material, present) ? window.open("", "_blank") : null;
  if (popup) popup.opener = null;
  return popup;
}
function requestMaterialAction(material: Material, present: boolean, selectedClassroom?: Classroom) {
  return request<{ url?: string; mode?: string }>("/" + material.id + "/" + (present ? "present" : "download"), { method: "POST", body: present ? JSON.stringify(selectedClassroom) : undefined });
}
function showMaterialAction(result: { url?: string }, popup: Window | null, notify?: (message: string) => void) {
  if (result.url) openUrl(result.url, popup);
  else { popup?.close(); notify?.("教材已提交到课堂"); }
}
function useMaterialActions(selectedClassroom: Classroom | undefined, notify: ((message: string) => void) | undefined, setError: (message: string) => void) {
  const [busy, setBusy] = useState("");
  const act = async (material: Material, present: boolean) => {
    const popup = materialPopup(material, present);
    setBusy(material.id); setError("");
    try { showMaterialAction(await requestMaterialAction(material, present, selectedClassroom), popup, notify); }
    catch (error) { popup?.close(); setError(messageOf(error)); }
    finally { setBusy(""); }
  };
  return { busy, act };
}

function readPickedFiles(event: { target: HTMLInputElement }, queueFiles: (files: File[]) => void) {
  if (event.target.files) queueFiles(Array.from(event.target.files));
  event.target.value = "";
}
function MaterialUploadControls({ canManage, canUpload, queueFiles, create }: { canManage: boolean; canUpload: boolean; queueFiles: (files: File[]) => void; create: (kind: "folder" | "link") => void }) {
  const input = useRef<HTMLInputElement>(null);
  const directory = useRef<HTMLInputElement>(null);
  if (!canManage) return null;
  return <>
    <button type="button" className={styles.secondary} onClick={() => create("folder")}><Plus size={16} />新建文件夹</button>
    <button type="button" className={styles.primary} disabled={!canUpload} onClick={() => input.current?.click()}><Upload size={16} />上传</button>
    <button type="button" className={styles.secondary} disabled={!canUpload} onClick={() => directory.current?.click()}><Folder size={16} />上传文件夹</button>
    <button type="button" className={styles.secondary} onClick={() => create("link")}><Link size={16} />添加链接</button>
    <input ref={input} className={styles.hidden} type="file" multiple accept={Object.keys(mimeTypes).map((extension) => "." + extension).join(",")} onChange={(event) => readPickedFiles(event, queueFiles)} />
    <input ref={directory} className={styles.hidden} type="file" multiple {...{ webkitdirectory: "" }} onChange={(event) => readPickedFiles(event, queueFiles)} />
  </>;
}
function MaterialSearch({ navigation }: { navigation: ReturnType<typeof useMaterialNavigation> }) {
  return <form className={styles.search} onSubmit={(event) => { event.preventDefault(); navigation.setSearch(navigation.query.trim()); }}><Search size={16} /><input aria-label="搜索教材" placeholder="搜索教材" value={navigation.query} onChange={(event) => navigation.setQuery(event.target.value)} /><button type="submit" className={styles.searchButton}>搜索</button></form>;
}
function MaterialBreadcrumbs({ folders, browse }: { folders: MaterialList["breadcrumbs"]; browse: (id: string | null) => void }) {
  return <nav className={styles.breadcrumbs} aria-label="教材目录"><button type="button" onClick={() => browse(null)}>学校资料</button>{folders.map((folder) => <span key={folder.id}><ChevronRight size={14} /><button type="button" onClick={() => browse(folder.id)}>{folder.name}</button></span>)}</nav>;
}

type CreateKind = "folder" | "link";
function createMaterialInput(kind: CreateKind, folderId: string | null, title: string, url: string) {
  return kind === "folder" ? { action: "create-folder", parentId: folderId, name: title.trim() } : { action: "create-link", folderId, title: title.trim(), sourceUrl: url.trim() };
}
function MaterialFormFields({ kind, title, setTitle, url, setUrl }: { kind: CreateKind; title: string; setTitle: (value: string) => void; url: string; setUrl: (value: string) => void }) {
  return <>
    <label className={styles.field}>名称<input required autoFocus maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    {kind === "link" && <label className={styles.field}>教材链接<input required type="url" value={url} onChange={(event) => setUrl(event.target.value)} /></label>}
  </>;
}
function createDisabled(busy: boolean, title: string) { return busy || !title.trim(); }
function CreateMaterialFooter({ close, busy, title }: { close: () => void; busy: boolean; title: string }) {
  return <footer><button type="button" className={styles.secondary} onClick={close}>取消</button><button className={styles.primary} disabled={createDisabled(busy, title)}>{busy ? "保存中…" : "保存"}</button></footer>;
}
function CreateMaterialDialog({ kind, folderId, close, saved }: { kind: CreateKind; folderId: string | null; close: () => void; saved: () => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <MaterialDialog title={kind === "folder" ? "新建文件夹" : "添加教材链接"} close={close}><form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await request("", { method: "POST", body: JSON.stringify(createMaterialInput(kind, folderId, title, url)) }); saved(); }
    catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }}>
    <MaterialFormFields kind={kind} title={title} setTitle={setTitle} url={url} setUrl={setUrl} />{error && <p role="alert" className={styles.error}>{error}</p>}<CreateMaterialFooter close={close} busy={busy} title={title} />
  </form></MaterialDialog>;
}
function MaterialDialogs({ modal, closeCreate, folderId, refresh, grantTarget, closeGrant, teachers, notify }: {
  modal: CreateKind | null; closeCreate: () => void; folderId: string | null; refresh: () => void; grantTarget: GrantTarget | null; closeGrant: () => void; teachers: Teacher[]; notify?: (message: string) => void;
}) {
  return <>
    {modal && <CreateMaterialDialog kind={modal} folderId={folderId} close={closeCreate} saved={() => { closeCreate(); refresh(); }} />}
    {grantTarget && <GrantDialog target={grantTarget} teachers={teachers} close={closeGrant} saved={() => { closeGrant(); refresh(); notify?.("教师授权已保存"); }} />}
  </>;
}
function storageError(data?: MaterialList) {
  if (!data || data.configured) return "";
  return data.error || "教材库尚未配置存储服务";
}
function MaterialAlerts({ errors }: { errors: Array<string | undefined> }) {
  return errors.filter(Boolean).map((error, index) => <p role="alert" className={styles.error} key={index}>{error}</p>);
}

export default function ClassroomMaterialsPanel({ teachers, selectedClassroom, notify }: {
  teachers: Teacher[]; selectedClassroom?: Classroom; notify?: (message: string) => void;
}) {
  const navigation = useMaterialNavigation();
  const { folderId, refresh, browse } = navigation;
  const [actionError, setActionError] = useState("");
  const [modal, setModal] = useState<"folder" | "link" | null>(null);
  const [grantTarget, setGrantTarget] = useState<GrantTarget | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadJobs = useMaterialUploadJobs(refresh);
  const { uploadRows } = uploadJobs;
  const listing = useMaterialListing(navigation, setActionError);
  const { loading } = listing;
  const data = listing.data || { canManage: false, configured: false, canPresent: false, breadcrumbs: [] };
  const canManage = !!data.canManage;
  const canUpload = canManage && !!data.configured;
  const queueFiles = useMaterialFileQueue({ folderId, data: listing.data, canUpload, refresh, setError: setActionError }, uploadJobs);
  const { busy: actionBusy, act: actOnMaterial } = useMaterialActions(selectedClassroom, notify, setActionError);
  return <section className={`${styles.panel} ${dragging ? styles.dragging : ""}`} aria-label="教材资料库"
    onDragOver={(event) => { if (canUpload && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); if (!canUpload) return; try { void queueFiles(materialDropFiles(event.dataTransfer)); } catch (error) { setActionError(messageOf(error)); } }}>
    <header className={styles.heading}><h2><Folder size={21} />资料库</h2><button type="button" className={styles.iconButton} aria-label="刷新资料库" onClick={refresh} disabled={loading}><RefreshCw size={16} /></button></header>
    <div className={styles.toolbar}><MaterialUploadControls canManage={canManage} canUpload={canUpload} queueFiles={queueFiles} create={setModal} /><MaterialSearch navigation={navigation} /></div>
    <MaterialBreadcrumbs folders={data.breadcrumbs} browse={browse} />
    <MaterialAlerts errors={[listing.error, storageError(listing.data), actionError]} />
    <div className={styles.list} aria-busy={loading}>
      <div className={styles.listHeader}><span>名称</span><span>大小</span><span>操作</span></div>
      <MaterialListBody listing={listing} navigation={navigation} interaction={{ canManage, canPresent: !!data.canPresent, selectedClassroom, busy: actionBusy, act: actOnMaterial, grant: setGrantTarget }} />
    </div>
    <MoreMaterials listing={listing} />
    <UploadQueue uploads={{ rows: uploadRows, pause: (id) => pauseUploadJob(uploadJobs, id), resume: (id) => resumeUploadJob(uploadJobs, id), clear: () => clearCompletedUploads(uploadJobs) }} />
    <MaterialDialogs modal={modal} closeCreate={() => setModal(null)} folderId={folderId} refresh={refresh} grantTarget={grantTarget} closeGrant={() => setGrantTarget(null)} teachers={teachers} notify={notify} />
  </section>;
}
