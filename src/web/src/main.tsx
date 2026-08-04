import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("页面根节点缺失");
}

createRoot(container).render(<App />);
