import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import "./index.css";
import App from "./App.tsx";
import { ThemeProvider } from "./components/ThemeProvider.tsx";
import { setPrototypes } from "./lib/prototypes.ts";
import { store } from "./store";

setPrototypes();
createRoot(document.getElementById("root")!).render(
  // <StrictMode>
  // Redux Provider must wrap ThemeProvider because ThemeProvider now reads
  // its preference via useAppSelector against this store.
  <Provider store={store}>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </Provider>,
  // </StrictMode >
);
