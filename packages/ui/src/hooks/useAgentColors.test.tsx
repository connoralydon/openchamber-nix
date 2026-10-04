import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Agent } from '@/lib/opencode/model';
import { projectAgent } from '@/lib/opencode/projection';
import { useConfigStore } from '@/stores/useConfigStore';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { MobileAgentButton } from '@/components/chat/MobileAgentButton';
import { useAgentColors } from './useAgentColors';

test('consumers share allocations and update together on roster and theme changes', async () => {
  const dom = new Window({ url: 'http://agent-colors.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const previousAgents = useConfigStore.getState().agents;
  const previousName = useConfigStore.getState().currentAgentName;
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, PointerEvent: dom.PointerEvent,
    fetch: async () => Response.json({ themes: [] }), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const agent = (name: string, color?: string): Agent => projectAgent({
    id: name, name, color, mode: 'primary', hidden: false,
    request: { settings: {}, headers: {}, body: {} }, permissions: [],
  });
  const agents = ['architect', 'build', 'plan', 'simplifier'].map((name) => agent(name));
  useConfigStore.setState({ agents, currentAgentName: 'build' });
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const seen = new Set<ReturnType<typeof useAgentColors>>();
  let changeTheme = () => {};
  function Probe() {
    const resolve = useAgentColors();
    seen.add(resolve);
    return <>
      <span data-agent-probe style={{ color: resolve('build').color }}>{resolve('build').color}</span>
      <span data-agent-footer-probe style={{ color: `var(${resolve('build').var})` }}>{resolve('build').var}</span>
    </>;
  }
  const cycleAgent = () => useConfigStore.setState({
    currentAgentName: useConfigStore.getState().currentAgentName === 'build' ? 'plan' : 'build',
  });
  function Controls() {
    const theme = useThemeSystem();
    changeTheme = () => theme.setTheme(theme.currentTheme.metadata.variant === 'dark' ? 'openchamber-light' : 'openchamber-dark');
    return null;
  }
  try {
    await act(async () => root.render(<ThemeSystemProvider><Controls /><MobileAgentButton onCycleAgent={cycleAgent} onOpenAgentPanel={() => {}} />{Array.from({ length: 100 }, (_, index) => <Probe key={index} />)}</ThemeSystemProvider>));
    expect(seen.size).toBe(1);
    expect(container.querySelector('button')?.style.color).toBe('var(--status-success)');
    await act(async () => useConfigStore.setState({ currentAgentName: 'plan' }));
    expect(seen.size).toBe(1);
    expect(container.querySelector('button')?.style.color).toBe([...seen][0]('plan').color);
    await act(async () => useConfigStore.setState({ agents: [...agents, { ...agent('internal'), hidden: true }] }));
    expect(seen.size).toBe(2);
    const [initial, hiddenAdded] = [...seen];
    for (const { name } of agents) expect(hiddenAdded(name)).toEqual(initial(name));
    await act(async () => changeTheme());
    expect(seen.size).toBe(3);
    for (const resolve of seen) expect(resolve('build').var).toBe('--status-success');
    expect(container.querySelectorAll('[data-agent-probe]').length).toBe(100);
    await act(async () => useConfigStore.setState({
      agents: agents.map(({ name }) => agent(name, name === 'build' ? '#ff6b6b' : name === 'plan' ? '#6699cc' : undefined)),
      currentAgentName: 'build',
    }));
    expect(seen.size).toBe(4);
    expect([...seen][3]('build').color).toBe('#ff6b6b');
    for (const probe of container.querySelectorAll('[data-agent-probe]')) expect(probe.textContent).toBe('#ff6b6b');
    expect(container.querySelector('button')?.style.color).toBe('#ff6b6b');
    await act(async () => container.querySelector('button')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
    expect(useConfigStore.getState().currentAgentName).toBe('plan');
    expect(container.querySelector('button')?.style.color).toBe('#6699cc');
    expect(seen.size).toBe(4);
    await act(async () => container.querySelector('button')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
    expect(useConfigStore.getState().currentAgentName).toBe('build');
    expect(container.querySelector('button')?.style.color).toBe('#ff6b6b');
    for (const probe of container.querySelectorAll<HTMLSpanElement>('[data-agent-footer-probe]')) {
      expect(probe.style.color).toBe('var(--status-success)');
    }
    await act(async () => changeTheme());
    expect(seen.size).toBe(5);
    expect([...seen][4]('build').color).toBe('#ff6b6b');
    expect(container.querySelector('button')?.style.color).toBe('#ff6b6b');
    await act(async () => useConfigStore.setState({ agents }));
    expect(seen.size).toBe(5);
    for (const probe of container.querySelectorAll('[data-agent-probe]')) expect(probe.textContent).toBe('var(--status-success)');
    expect(container.querySelector('button')?.style.color).toBe('var(--status-success)');
  } finally {
    await act(async () => root.unmount());
    useConfigStore.setState({ agents: previousAgents, currentAgentName: previousName });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
