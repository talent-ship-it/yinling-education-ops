"use client";
import { useRef, useState } from "react";
type Option = { id: string; name: string; detail?: string };
/** The visible control contains a name; only a selected record's ID is submitted. */
export function RecordPicker({ name, options, value, initialValue = "", onChange, disabled = false }: { name: string; options: Option[]; value?: string; initialValue?: string; onChange?: (id: string) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(initialValue);
  const [query, setQuery] = useState<string | null>(null);
  const id = value ?? selected;
  const record = options.find((option) => option.id === id);
  return <div className="record-picker"><input type="hidden" name={name} value={id} /><input ref={inputRef} aria-label={name === "studentId" ? "搜索学生姓名" : "搜索老师姓名"} value={query ?? record?.name ?? ""} required disabled={disabled} placeholder="输入姓名搜索并选择" onChange={(event) => { event.currentTarget.setCustomValidity("请从候选列表选择一位人员"); setQuery(event.target.value); setSelected(""); onChange?.(""); }} onFocus={() => { if (!disabled) setQuery(record?.name ?? ""); }} />{query !== null && !disabled && <div className="record-picker-options" role="group" aria-label="姓名搜索结果">{options.filter((option) => `${option.name} ${option.id} ${option.detail ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 30).map((option) => <button className="record-picker-option" type="button" key={option.id} onClick={() => { inputRef.current?.setCustomValidity(""); setSelected(option.id); onChange?.(option.id); setQuery(null); }}><strong>{option.name}</strong><small>{option.detail} · {option.id}</small></button>)}<button type="button" className="text-button" onClick={() => setQuery(null)}>关闭候选列表</button></div>}</div>;
}
