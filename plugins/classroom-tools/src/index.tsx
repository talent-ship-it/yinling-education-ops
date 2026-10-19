import React from "react";
import { createRoot } from "react-dom/client";
import Plugin from "./Plugin";
const uuid = document.currentScript?.getAttribute("uuid");
const element = uuid ? document.getElementById(uuid) : null;
if (uuid && element) {
  createRoot(element).render(<Plugin uuid={uuid} />);
}
