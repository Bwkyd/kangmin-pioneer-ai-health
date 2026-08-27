import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./AdminApp";
import "./styles.css";
import "./overview.css";

const root = document.getElementById("admin-root");
if (root === null) throw new Error("缺少管理后台挂载节点");

createRoot(root).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>
);
