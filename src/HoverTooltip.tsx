import { createPortal } from "react-dom";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type HoverTooltipDetails = {
  appName?: string | null;
  appMinutes?: number;
};

export type HoverTooltipHandle = {
  show(text: string, clientX: number, clientY: number, details?: HoverTooltipDetails): void;
  move(clientX: number, clientY: number): void;
  hide(): void;
};

type HoverTooltipProps = {
  buildPosition(
    clientX: number,
    clientY: number,
    tooltipWidth?: number,
    tooltipHeight?: number,
  ): { left: number; top: number };
};

const appIconClass = (appName: string) => {
  const normalized = appName.toLowerCase();
  if (normalized.includes("chrome")) return "chrome";
  if (normalized.includes("safari")) return "safari";
  if (normalized.includes("slack")) return "slack";
  if (normalized.includes("figma")) return "figma";
  if (normalized.includes("notion")) return "notion";
  if (normalized.includes("code") || normalized.includes("cursor")) return "code";
  if (normalized.includes("terminal") || normalized.includes("iterm")) return "terminal";
  return "generic";
};

const displayAppName = (appName: string) => appName.replace(/^Google\s+/i, "");

const renderTooltipContent = (
  tooltip: HTMLDivElement,
  text: string,
  details?: HoverTooltipDetails,
) => {
  const lines = text.split("\n").filter(Boolean);
  const content = document.createElement("span");
  content.className = "hover-tooltip-content";

  for (const lineText of lines) {
    const line = document.createElement("span");
    line.className = "hover-tooltip-line";
    line.textContent = lineText;
    content.append(line);
  }

  const appName = details?.appName?.trim();
  if (appName) {
    const appRow = document.createElement("span");
    appRow.className = "hover-tooltip-app";

    const icon = document.createElement("span");
    icon.className = `hover-app-icon ${appIconClass(appName)}`;
    icon.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "hover-app-label";
    label.textContent = displayAppName(appName);

    appRow.append(icon, label);

    if (details?.appMinutes && details.appMinutes > 1) {
      const minutes = document.createElement("span");
      minutes.className = "hover-app-minutes";
      minutes.textContent = `${details.appMinutes}m`;
      appRow.append(minutes);
    }

    content.append(appRow);
  }

  tooltip.replaceChildren(content);
};

const HoverTooltip = forwardRef<HoverTooltipHandle, HoverTooltipProps>(function HoverTooltip(
  { buildPosition },
  ref,
) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const queuedPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      show(text, clientX, clientY, details) {
        const tooltip = tooltipRef.current;
        if (!tooltip) return;
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        queuedPointerRef.current = null;

        renderTooltipContent(tooltip, text, details);
        tooltip.classList.remove("is-visible");
        tooltip.hidden = false;
        tooltip.style.visibility = "hidden";

        const position = buildPosition(
          clientX,
          clientY,
          tooltip.offsetWidth,
          tooltip.offsetHeight,
        );
        tooltip.style.left = `${position.left}px`;
        tooltip.style.top = `${position.top}px`;
        tooltip.style.visibility = "";

        void tooltip.offsetWidth;
        tooltip.classList.add("is-visible");
      },
      move(clientX, clientY) {
        const tooltip = tooltipRef.current;
        if (!tooltip || tooltip.hidden) return;
        queuedPointerRef.current = { clientX, clientY };
        if (frameRef.current !== null) return;

        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          const tooltip = tooltipRef.current;
          const queuedPointer = queuedPointerRef.current;
          if (!tooltip || tooltip.hidden || !queuedPointer) return;

          queuedPointerRef.current = null;
          const position = buildPosition(
            queuedPointer.clientX,
            queuedPointer.clientY,
            tooltip.offsetWidth,
            tooltip.offsetHeight,
          );
          tooltip.style.left = `${position.left}px`;
          tooltip.style.top = `${position.top}px`;
        });
      },
      hide() {
        const tooltip = tooltipRef.current;
        if (!tooltip) return;
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        queuedPointerRef.current = null;

        tooltip.hidden = true;
        tooltip.style.visibility = "";
        tooltip.classList.remove("is-visible");
        tooltip.replaceChildren();
      },
    }),
    [buildPosition],
  );

  return createPortal(
    <div ref={tooltipRef} className="hover-tooltip" hidden aria-hidden="true" />,
    document.body,
  );
});

export default HoverTooltip;
