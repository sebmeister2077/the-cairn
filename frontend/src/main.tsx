import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ThemeProvider } from "./components/ThemeProvider.tsx";
import { setPrototypes } from "./lib/prototypes.ts";

setPrototypes();
createRoot(document.getElementById("root")!).render(
  // <StrictMode>
  <ThemeProvider>
    <App />
  </ThemeProvider>,
  // </StrictMode >
);
