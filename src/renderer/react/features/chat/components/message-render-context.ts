import { createContext } from "react";

/** Shared by the chat list and the deferred Markdown renderer. */
export const MessageStreamingContext = createContext(false);
