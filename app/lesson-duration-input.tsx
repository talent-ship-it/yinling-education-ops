"use client";
import { useState } from "react";
export function LessonDurationInput({ initialValue = 60 }: { initialValue?: number }) {
  const [value, setValue] = useState(String(initialValue));
  return <div className="duration-field"><input name="duration" aria-label="课程时长（分钟）" type="number" min="15" max="360" step="1" required value={value} onChange={(event) => setValue(event.target.value)} /><div className="toolbar-actions">{[60, 90, 120, 180].map((minutes) => <button type="button" className="secondary-button" key={minutes} aria-pressed={value === String(minutes)} onClick={() => setValue(String(minutes))}>{minutes} 分钟</button>)}</div><small>可填写 15–360 分钟</small></div>;
}
