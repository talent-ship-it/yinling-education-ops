"use client";

import { Clock3, Copy, ExternalLink, FilePlus2, RefreshCw, ShieldCheck, Video } from "lucide-react";
import type { ClassroomAttendance } from "@/lib/classroom-attendance";

function ClassroomAttendanceDetails({ attendance, unavailable, formatTime }: {
  attendance?: ClassroomAttendance | null;
  unavailable?: boolean;
  formatTime: (value: string) => string;
}) {
  return <div className="detail-section">
    <span>进出课堂记录</span>
    {attendance ? (["teacher", "student"] as const).map((party) => {
      const record = attendance[party];
      return <div key={party}>
        <strong>{party === "teacher" ? "老师" : "学生"}</strong>
        {record ? <>
          <p>进入 {formatTime(record.firstJoinedAt)}</p>
          <p>离开 {formatTime(record.lastLeftAt)}</p>
          <p>在线 {Math.floor(record.durationSeconds / 60)} 分钟 · {record.lateSeconds > 0 ? `迟到 ${Math.ceil(record.lateSeconds / 60)} 分钟` : "准时"}</p>
        </> : <p>未收到进出课堂记录</p>}
      </div>;
    }) : <p>{unavailable ? "出勤记录读取失败，请刷新重试" : "出勤记录待同步"}</p>}
  </div>;
}

type LessonActionsProps = {
  playbackUrl?: string;
  recordingPending: boolean;
  canOpenWhiteboard: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  openWhiteboard: () => Promise<unknown>;
  notify: (message: string) => void;
};

async function openBoard({ setBusy, openWhiteboard, notify }: LessonActionsProps) {
  setBusy(true);
  try {
    await openWhiteboard();
    notify("白色板书已提交到课堂");
  } catch (error) {
    notify(error instanceof Error ? error.message : "白色板书打开失败");
  } finally {
    setBusy(false);
  }
}

function ClassroomPlayback({ playbackUrl, recordingPending, notify }: Pick<LessonActionsProps, "playbackUrl" | "recordingPending" | "notify">) {
  if (!playbackUrl) return recordingPending ? <div className="classroom-recording-pending">
    <Clock3 size={16} />
    <span><strong>录播处理中</strong><small>供应商处理完成后会在这里出现回放链接</small></span>
  </div> : null;
  return <>
    <a className="secondary-button full classroom-recording-link" href={playbackUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> 打开课堂录播</a>
    <button className="secondary-button full" type="button" onClick={() => void navigator.clipboard.writeText(playbackUrl).then(() => notify("课堂录像链接已复制")).catch(() => notify("复制失败，请重试"))}><Copy size={16} /> 复制录像链接</button>
  </>;
}

function ClassroomLessonActions(props: LessonActionsProps) {
  return <>
    {props.canOpenWhiteboard && <button className="secondary-button full" type="button" disabled={props.busy} onClick={() => void openBoard(props)}><FilePlus2 size={16} /> 打开白色板书</button>}
    <ClassroomPlayback {...props} />
  </>;
}

type RoomControlsProps = {
  historical: boolean;
  hasMeeting: boolean;
  closed: boolean;
  busy: boolean;
  canJoin: boolean;
  canEnd: boolean;
  running: boolean;
  hasSavedMeeting: boolean;
  create: () => void;
  join: () => void;
  copyStudentLink: () => void;
  refresh: () => void;
  end: () => void;
};

function ClassroomLiveControls(props: RoomControlsProps) {
  return <>
    {!props.closed && <>
      <button className="primary-button full" type="button" disabled={props.busy || !props.canJoin} onClick={props.join}><ExternalLink size={16} /> {props.busy ? "正在处理…" : props.canJoin ? "老师进入教室" : "等待授课老师进入"}</button>
      <button className="secondary-button full" type="button" disabled={props.busy} onClick={props.copyStudentLink}><Copy size={16} /> {props.busy ? "正在处理…" : "复制学生进入链接"}</button>
    </>}
    <button className="secondary-button full" type="button" disabled={props.busy} onClick={props.refresh}><RefreshCw size={16} /> 刷新教室状态</button>
    {props.running && <button className="danger-button full" type="button" disabled={props.busy || !props.canEnd} onClick={props.end}><ShieldCheck size={16} /> 结束课堂</button>}
  </>;
}

function ClassroomRoomControls(props: RoomControlsProps) {
  if (props.historical) return props.hasSavedMeeting ? <button className="secondary-button full" type="button" disabled={props.busy} onClick={props.refresh}><RefreshCw size={16} /> 刷新历史录播</button> : null;
  if (!props.hasMeeting) return <button className="primary-button full" type="button" disabled={props.busy} onClick={props.create}><Video size={16} /> {props.busy ? "正在创建…" : "创建在线教室"}</button>;
  return <ClassroomLiveControls {...props} />;
}


type LessonDetailsProps = {
  runtime?: { running: boolean; participantCount: number; moderatorCount: number; attendance?: ClassroomAttendance | null; attendanceUnavailable?: boolean } | null;
  invitationUrl?: string;
  scheduledTime: string;
  timezone: string;
  duration: number;
  durationUnit: string;
  formatTime: (value: string) => string;
  notify: (message: string) => void;
};

function ClassroomInvitation({ invitationUrl, notify }: Pick<LessonDetailsProps, "invitationUrl" | "notify">) {
  if (!invitationUrl) return null;
  return <div className="classroom-share-link">
    <label>学生邀请链接<input aria-label="学生邀请链接" value={invitationUrl} readOnly /></label>
    <button className="secondary-button" type="button" onClick={() => void navigator.clipboard.writeText(invitationUrl).then(() => notify("学生进入链接已复制")).catch(() => notify("复制失败，请手动选择并复制链接"))}><Copy size={16} /> 复制链接</button>
    <a className="secondary-button" href={invitationUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> 打开学生端</a>
  </div>;
}

function ClassroomLessonDetails(props: LessonDetailsProps) {
  return <>
    {props.runtime?.running && <div className="classroom-link-preview"><Video size={24} /><span><strong>{props.runtime.participantCount} 人在线 · {props.runtime.moderatorCount} 位老师</strong></span></div>}
    <ClassroomInvitation {...props} />
    <div className="detail-section"><span>课程时间</span><strong>{props.scheduledTime}</strong><p>{props.timezone} · {props.duration} {props.durationUnit}</p></div>
    {props.runtime && <ClassroomAttendanceDetails attendance={props.runtime.attendance} unavailable={props.runtime.attendanceUnavailable} formatTime={props.formatTime} />}
  </>;
}

function ClassroomConnecting() {
  return <div className="classroom-recording-pending"><Clock3 size={16} /><span><strong>正在连接课堂服务</strong><small>通常需要 10–30 秒，请不要重复点击或关闭新标签页</small></span></div>;
}

type LessonToolsProps =
  | ({ section: "details" } & LessonDetailsProps)
  | ({ section: "actions" } & LessonActionsProps)
  | ({ section: "controls" } & RoomControlsProps)
  | { section: "connecting" };

export default function ClassroomLessonTools(props: LessonToolsProps) {
  if (props.section === "details") return <ClassroomLessonDetails {...props} />;
  if (props.section === "controls") return <ClassroomRoomControls {...props} />;
  if (props.section === "connecting") return <ClassroomConnecting />;
  return <ClassroomLessonActions {...props} />;
}
