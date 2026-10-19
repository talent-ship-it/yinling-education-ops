import test from "node:test";
import assert from "node:assert/strict";
import React, { createContext, useContext, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginApi } from "bigbluebutton-html-plugin-sdk";
import type { NativeTimerState } from "../src/timer";
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { currentScript: null } });
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
