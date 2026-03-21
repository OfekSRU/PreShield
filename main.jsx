import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./preshield.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
