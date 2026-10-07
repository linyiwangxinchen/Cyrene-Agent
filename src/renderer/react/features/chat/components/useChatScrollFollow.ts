import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** The outer viewport owns scrolling for both ordinary and virtual messages. */
export function useChatScrollFollow({ conversationId, revision, latestUserId, onVisibilityChange }: {
  conversationId?: string;
  revision: unknown;
  latestUserId?: string;
  onVisibilityChange?: (visible: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const lastScrollTop = useRef(0);
  const previousUser = useRef(latestUserId);
  const visibilityCallback = useRef(onVisibilityChange);
  visibilityCallback.current = onVisibilityChange;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = containerRef.current;
    if (!el) return;
    isNearBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
    lastScrollTop.current = el.scrollTop;
    visibilityCallback.current?.(false);
  }, []);

  const updateScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    // Growth alone can emit scroll events without any user scroll. Keep following
    // in that case; upward movement is the signal to pause following the tail.
    if (nearBottom) isNearBottomRef.current = true;
    else if (el.scrollTop !== lastScrollTop.current) isNearBottomRef.current = false;
    lastScrollTop.current = el.scrollTop;
    visibilityCallback.current?.(!isNearBottomRef.current);
  }, []);

  useLayoutEffect(() => {
    previousUser.current = latestUserId;
    scrollToBottom();
  }, [conversationId, scrollToBottom]);

  useLayoutEffect(() => {
    const newUserTurn = latestUserId !== previousUser.current;
    previousUser.current = latestUserId;
    if (newUserTurn || isNearBottomRef.current) scrollToBottom();
  }, [revision, latestUserId, scrollToBottom]);

  useEffect(() => {
    const viewport = containerRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    // Images, markdown and composer resizing can change layout after the delta.
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) scrollToBottom();
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  return { containerRef, contentRef, isNearBottomRef, scrollToBottom, updateScrollState };
}
