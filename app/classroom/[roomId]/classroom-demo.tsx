"use client";

import {
  ArrowLeft,
  BarChart3,
  Camera,
  CameraOff,
  Check,
  Clock3,
  Copy,
  Mic,
  MicOff,
  MonitorUp,
  PenTool,
  PhoneOff,
  RotateCcw,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./classroom-demo.module.css";

export default function ClassroomDemo({ roomId }: { roomId: string }) {
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [tool, setTool] = useState<"whiteboard" | "poll">("whiteboard");
  const [seconds, setSeconds] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const [answer, setAnswer] = useState<string>("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!timerRunning) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [timerRunning]);

  const notify = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2400);
  };

  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return <main className={styles.shell}>
    <header className={styles.header}>
      <div className={styles.roomIdentity}><Link href="/" aria-label="返回教务系统"><ArrowLeft size={18} /></Link><span><small>吟领网上教室 · Demo</small><strong>{roomId}</strong></span></div>
      <div className={styles.headerActions}><span><Users size={15} /> 2 人在线</span><button type="button" onClick={async () => { await navigator.clipboard.writeText(window.location.href); notify("教室链接已复制"); }}><Copy size={15} /> 复制链接</button></div>
    </header>

    <section className={styles.stage}>
      <div className={styles.videoArea}>
        <article className={styles.primaryVideo}>
          <div className={styles.demoPerson}><span>老</span><strong>老师画面</strong><small>{cameraOn ? "Demo 摄像头画面" : "摄像头已关闭"}</small></div>
          <em>主讲老师</em>
        </article>
        <article className={styles.studentVideo}><div className={styles.demoPerson}><span>学</span><strong>学生画面</strong><small>Demo 参会者</small></div><em>学生</em></article>
      </div>

      <aside className={styles.tools}>
        <nav><button className={tool === "whiteboard" ? styles.active : ""} type="button" onClick={() => setTool("whiteboard")}><PenTool size={16} /> 白板</button><button className={tool === "poll" ? styles.active : ""} type="button" onClick={() => setTool("poll")}><BarChart3 size={16} /> 选择题</button></nav>
        {tool === "whiteboard" ? <section className={styles.whiteboard}><div className={styles.whiteboardBar}><span><i /><i /><i /></span><button type="button" onClick={() => notify("白板已清空（Demo）")}><RotateCcw size={14} /> 清空</button></div><div className={styles.canvas}><strong>y = 2x + 3</strong><span>请标出直线与 y 轴的交点</span><div className={styles.axis}><i /><b /></div></div></section> : <section className={styles.poll}><p>快速选择题</p><h2>当 x = 2 时，y = 2x + 3 的值是多少？</h2>{["5", "7", "9", "11"].map((option) => <button className={answer === option ? styles.selectedAnswer : ""} type="button" key={option} onClick={() => setAnswer(option)}><span>{option}</span>{answer === option && <Check size={16} />}</button>)}<small>{answer ? `已选择 ${answer}（Demo 不提交数据）` : "请选择一个答案"}</small></section>}
      </aside>
    </section>

    <footer className={styles.controls}>
      <div><button className={!micOn ? styles.off : ""} type="button" onClick={() => setMicOn((value) => !value)}>{micOn ? <Mic size={19} /> : <MicOff size={19} />}<span>{micOn ? "麦克风" : "已静音"}</span></button><button className={!cameraOn ? styles.off : ""} type="button" onClick={() => setCameraOn((value) => !value)}>{cameraOn ? <Camera size={19} /> : <CameraOff size={19} />}<span>{cameraOn ? "摄像头" : "已关闭"}</span></button><button type="button" onClick={() => notify("屏幕共享为界面演示，尚未连接真实服务")}><MonitorUp size={19} /><span>共享屏幕</span></button></div>
      <button className={styles.timer} type="button" onClick={() => setTimerRunning((value) => !value)}><Clock3 size={18} /><strong>{time}</strong><span>{timerRunning ? "暂停" : "开始计时"}</span></button>
      <button className={styles.end} type="button" onClick={() => notify("Demo 课程已结束，不会写入真实课时")}><PhoneOff size={19} /><span>结束课堂</span></button>
    </footer>
    <div className={styles.demoBadge}>界面功能演示 · 未连接真实音视频、录制或扣课服务</div>
    {notice && <div className={styles.toast}><Check size={16} /> {notice}</div>}
  </main>;
}
