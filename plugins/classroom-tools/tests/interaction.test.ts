import test from "node:test";
import assert from "node:assert/strict";
import React, { createContext, useContext, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginApi } from "bigbluebutton-html-plugin-sdk";
import type { NativeTimerState } from "../src/timer";
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: Object.assign(new EventTarget(), { currentScript: null, hidden: false, fullscreenElement: null }) });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: () => 1 });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: () => {} });
const { ClassroomTools } = await import("../src/Plugin");
test("teacher start, pause, resume, reset and student display follow native acknowledgements", async () => {
  const initial: NativeTimerState = { active: false, running: false, stopwatch: true, time: 300000, accumulated: 0, elapsed: false, timePassed: 300000 };
  type ContextValue = { timer: NativeTimerState; role: string; mutate: (query: string, variables: {time?: number;stopwatch?: boolean}) => void };
  const Context = createContext<ContextValue>({timer:initial,role:"MODERATOR",mutate:()=>{}});
  const commands: string[] = [];
  let toolbar: {id:string;onClick:()=>void}[] = [];
  let changeTimer: React.Dispatch<React.SetStateAction<NativeTimerState>>;
  let changeRole: React.Dispatch<React.SetStateAction<string>>;
  const api = {
    useCurrentUser: () => { const {role} = useContext(Context); return { data: { role, presenter: role === "MODERATOR" }, loading: false }; },
    useTimer: () => ({ data: useContext(Context).timer, loading: false }),
    useShouldUnmountPlugin: () => false,
    useCustomMutation: (query: string) => { const {mutate} = useContext(Context); return [(args: {variables: {time?: number;stopwatch?: boolean}}) => mutate(query,args.variables), {loading:false}]; },
    setPresentationToolbarItems: (items: typeof toolbar) => { toolbar = items; },
  } as unknown as PluginApi;
  function Harness() {
    const [timer,setTimer] = useState(initial); const [role,setRole] = useState("MODERATOR");
    changeTimer=setTimer; changeRole=setRole;
    const mutate: ContextValue["mutate"] = (query,variables) => {
      setTimer(old => {
        if(query.includes("timerActivate(")) { commands.push("activate"); return {...old,active:true,running:false,stopwatch:true,time:variables.time!,timePassed:variables.time!,accumulated:0,elapsed:false}; }
        if(query.includes("timerSwitchMode(")) { commands.push("mode"); return {...old,stopwatch:variables.stopwatch!}; }
        if(query.includes("timerSetTime(")) { commands.push("time"); return {...old,time:variables.time!,timePassed:variables.time!}; }
        if(query.includes("timerReset")) { commands.push("reset"); return {...old,accumulated:0,timePassed:old.time,elapsed:false}; }
        if(query.includes("timerStart")) { commands.push("start"); return {...old,running:true}; }
        if(query.includes("timerStop")) { commands.push("stop"); return {...old,running:false,accumulated:old.time-old.timePassed}; }
        if(query.includes("timerDeactivate")) { commands.push("deactivate"); return {...old,active:false,running:false}; }
        return old;
      });
    };
    return React.createElement(Context.Provider,{value:{timer,role,mutate}},React.createElement(ClassroomTools,{api}));
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer=create(React.createElement(Harness)); });
  try {
    await act(async () => { toolbar.find(item=>item.id==="insider-classroom-timer")!.onClick(); });
    const primary = () => renderer.root.findAllByType("button").find(button=>button.props.className==="ilct-primary")!;
    const digits = () => renderer.root.findAllByType("output").map(output=>output.children.join("")).join("");
    await act(async () => { primary().props.onClick(); });
    assert.deepEqual(commands,["activate","mode","start"]);
    assert.equal(primary().children.join(""),"暂停");
    assert.equal(digits(),"0500");
    await act(async () => { changeTimer(old=>({...old,timePassed:178000})); });
    assert.equal(digits(),"0258");
    await act(async () => { primary().props.onClick(); });
    assert.equal(primary().children.join(""),"继续");
    assert.equal(digits(),"0258");
    await act(async () => { primary().props.onClick(); });
    assert.equal(commands.at(-1),"start");
    assert.equal(primary().children.join(""),"暂停");
    await act(async () => { renderer.root.findAllByType("button").find(button=>button.children.join("")==="重置")!.props.onClick(); });
    assert.deepEqual(commands.slice(-2),["stop","reset"]);
    assert.equal(digits(),"0500");
    assert.equal(primary().children.join(""),"开始");
    await act(async () => { changeRole("VIEWER"); changeTimer(old=>({...old,accumulated:122000,timePassed:178000})); });
    assert.equal(renderer.root.findAllByProps({className:"ilct-readonly"})[0].children.join(""),"02:58");
    assert.equal(renderer.root.findAllByProps({className:"ilct-primary"}).length,0);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("fullscreen rejection is visible and student visibility uses a moderator-only SDK channel with transport identity", async () => {
  const target = Object.assign(new EventTarget(), { currentScript: null, hidden: false, fullscreenElement: null, documentElement: { requestFullscreen: () => { fullscreenCalls++; return Promise.reject(new Error("denied")); } } });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: target });
  let fullscreenCalls = 0;
  let toolbar: { id: string; onClick: () => void }[] = [];
  const sent: { report: unknown; options: unknown }[] = [];
  type Entry = { entryId: string; createdBy: string; createdAt: string; payloadJson: unknown };
  const Context = createContext({ role: "VIEWER", entries: [] as Entry[] });
  let setValue!: React.Dispatch<React.SetStateAction<React.ContextType<typeof Context>>>;
  const api = {
    useCurrentUser: () => ({ data: { role: useContext(Context).role, presenter: false }, loading: false }),
    useTimer: () => ({ loading: false }),
    useShouldUnmountPlugin: () => false,
    useDataChannel: (name: string, mode: string) => {
      assert.equal(name, "classroom-visibility"); assert.equal(mode, "Hooks::DataChannel::NewItems");
      return { data: { data: useContext(Context).entries, loading: false }, pushEntry: (report: unknown, options: unknown) => sent.push({ report, options }) };
    },
    useUsersBasicInfo: () => ({ data: { user: [{ userId: "transport-student", name: "合成学生", isModerator: false }] }, loading: false }),
    setPresentationToolbarItems: (items: typeof toolbar) => { toolbar = items; },
  } as unknown as PluginApi;
  function Harness() {
    const [value, setState] = useState({ role: "VIEWER", entries: [] as Entry[] });
    setValue = setState;
    return React.createElement(Context.Provider, { value }, React.createElement(ClassroomTools, { api }));
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Harness)); });
  try {
    await act(async () => { toolbar.find((item) => item.id === "insider-classroom-fullscreen")!.onClick(); assert.equal(fullscreenCalls, 1); });
    assert.match(JSON.stringify(renderer.toJSON()), /未能进入或退出全屏/);
    await act(async () => { target.hidden = true; target.dispatchEvent(new Event("visibilitychange")); });
    assert.deepEqual(sent[0], { report: { version: 1, state: "hidden" }, options: { receivers: [{ role: "MODERATOR" }] } });
    await act(async () => { target.hidden = false; target.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { renderer.root.findByProps({ "aria-label": "关闭提醒" }).props.onClick(); });
    await act(async () => { target.hidden = true; target.dispatchEvent(new Event("visibilitychange")); target.hidden = false; target.dispatchEvent(new Event("visibilitychange")); });
    assert.match(JSON.stringify(renderer.toJSON()), /已返回课堂，请继续专注上课/);
    await act(async () => { setValue({ role: "MODERATOR", entries: [{ entryId: "one", createdBy: "transport-student", createdAt: "2026-10-19T00:00:00Z", payloadJson: { version: 1, state: "hidden", name: "伪造姓名" } }] }); });
    assert.match(JSON.stringify(renderer.toJSON()), /合成学生切换出了课堂页面/);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /伪造姓名/);
    const count = sent.length;
    await act(async () => { target.hidden = true; target.dispatchEvent(new Event("visibilitychange")); });
    assert.equal(sent.length, count);
  } finally { await act(async () => { renderer.unmount(); }); }
});
