export type MouseEvent = {
  type: "mouseEvent";
  pageId: string;
  event: {
    type: "mousePressed" | "mouseReleased" | "mouseWheel" | "mouseMoved";
    x: number;
    y: number;
    button: "none" | "left" | "middle" | "right";
    buttons?: number;
    modifiers: number;
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
  };
};

export type KeyEvent = {
  type: "keyEvent";
  pageId: string;
  event: {
    type: "keyDown" | "keyUp" | "char";
    text?: string;
    code: string;
    key: string;
    keyCode: number;
    modifiers?: number;
  };
};

export type NavigationEvent = {
  type: "navigation";
  pageId: string;
  event: {
    url?: string;
    action?: "back" | "forward" | "refresh";
  };
};

export type CloseTabEvent = {
  type: "closeTab";
  pageId: string;
};

export type ClipboardWriteEvent = {
  type: "clipboardWrite";
  pageId: string;
  event: {
    text: string;
  };
};

export type ClipboardReadEvent = {
  type: "clipboardRead";
  pageId: string;
};

export type GetSelectedTextEvent = {
  type: "getSelectedText";
  pageId: string;
};

export type ResizeEvent = {
  type: "resize";
  pageId: string;
  revision?: number;
  width: number;
  height: number;
  mobile: boolean;
  deviceScaleFactor: number;
};

export type PageInfo = {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
};
