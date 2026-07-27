"use client";

import { ChevronDown, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { isDemoTeacher } from "@/lib/demo-users";
import styles from "./account-menu.module.css";

type ViewOption = { label: string; value: string };

export default function AccountMenu() {
  const [sessionUser, setSessionUser] = useState("");
  const [currentView, setCurrentView] = useState("");
  const [viewOptions, setViewOptions] = useState<ViewOption[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let resolved = false;
    const loadSession = async () => {
      if (resolved) return;
      try {
        const response = await fetch("/api/demo-session", { cache: "no-store" });
        const body = await response.json();
        if (body.ok && typeof body.user === "string") {
          resolved = true;
          setSessionUser(body.user);
        }
      } catch {
        // The login screen remains usable while the session endpoint is unavailable.
      }
    };
    void loadSession();
    const timer = window.setInterval(loadSession, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const syncView = () => {
      const source = document.querySelector<HTMLSelectElement>(".operator select");
      if (!source) return;
      const operator = source.closest<HTMLElement>(".operator");
      if (operator) operator.style.visibility = "hidden";
      setCurrentView(source.value);
      setViewOptions(Array.from(source.options, (option) => ({ label: option.text, value: option.value })));
    };
    syncView();
    const observer = new MutationObserver(syncView);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      const operator = document.querySelector<HTMLElement>(".operator");
      if (operator) operator.style.visibility = "";
    };
  }, []);

  useEffect(() => {
    const adjustMobileHeader = () => {
      const sync = document.querySelector<HTMLElement>(".live-sync");
      if (sync) sync.style.marginRight = window.innerWidth <= 760 ? "44px" : "";
    };
    adjustMobileHeader();
    window.addEventListener("resize", adjustMobileHeader);
    return () => {
      window.removeEventListener("resize", adjustMobileHeader);
      const sync = document.querySelector<HTMLElement>(".live-sync");
      if (sync) sync.style.marginRight = "";
    };
  }, []);

  const changeView = (value: string) => {
    const source = document.querySelector<HTMLSelectElement>(".operator select");
    if (!source) return;
    source.value = value;
    source.dispatchEvent(new Event("change", { bubbles: true }));
    setCurrentView(value);
  };

  const logout = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/demo-logout", { method: "POST" });
      if (!response.ok) {
        setBusy(false);
        return;
      }
      window.location.assign("/");
    } catch {
      setBusy(false);
    }
  };

  if (!sessionUser) return null;
  const isAdmin = sessionUser === "Nixon";
  const isTeacher = isDemoTeacher(sessionUser);
  const displayName = isAdmin ? "Admin" : sessionUser;
  const initials = isAdmin ? "AD" : sessionUser.slice(0, 2).toUpperCase();

  return <div className={styles.root}>
    <button className={styles.trigger} type="button" aria-label="打开账户菜单">
      <span className={styles.avatar}>{initials}</span>
      <span className={styles.identity}><small>{isAdmin ? "超级管理员" : isTeacher ? "老师个人权限" : "教务个人权限"}</small><strong>{displayName}</strong></span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    <section className={styles.menu} aria-label="账户菜单">
      <div className={styles.loggedIn}><small>当前登录</small><strong>{displayName}</strong></div>
      {isAdmin && viewOptions.length > 1 && <label className={styles.viewPicker}><span>查看工作视图</span><select value={currentView} onChange={(event) => changeView(event.target.value)}>{viewOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>}
      <button className={styles.logout} type="button" disabled={busy} onClick={logout}><LogOut size={15} />{busy ? "正在退出" : "退出登录"}</button>
    </section>
  </div>;
}
