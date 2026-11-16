// 错误边界：子树抛异常时只换掉这一块，不让整页变黑。
//
// 界面上只留一个重试按钮（AGENTS.md：不堆说明文字）。点一下重新挂载子树，
// 地图那边常见的情况（某一版图层没挂好）重挂一次就恢复了。

import { Component, type ReactNode } from "react";
import { IconRestart } from "./icons";

interface Props {
  children: ReactNode;
  /** 出错时占位用的类名，默认铺满整个窗口。 */
  className?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("界面出错", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.className ? `crash ${this.props.className}` : "crash"}>
        <button
          className="ib"
          title="重试"
          aria-label="重试"
          onClick={() => this.setState({ error: null })}
        >
          <IconRestart />
        </button>
      </div>
    );
  }
}
