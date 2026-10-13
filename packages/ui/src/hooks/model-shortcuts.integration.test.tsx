import { afterAll, beforeAll, expect, test } from 'bun:test';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';

const directory = '/workspace/model-shortcuts';
const browser = new Window({ url: 'http://model-shortcuts.test' });
Object.defineProperty(browser.navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' });
Object.defineProperty(browser.navigator, 'platform', { value: 'MacIntel' });
const fetchResponse = async (request: Request | URL | string) => {
  const path = new URL(request instanceof Request ? request.url : request.toString(), 'http://model-shortcuts.test').pathname;
  if (path.endsWith('/event')) {
    return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (path === '/api/config/settings') return Response.json({});
  const data = path.endsWith('/location')
    ? { directory, project: { id: 'project', directory, canonical: directory } }
    : path.endsWith('/vcs') ? { data: { branch: { current: 'main', default: 'main' } } }
    : path.endsWith('/session/active') ? { data: {} }
    : path.endsWith('/config') || path.endsWith('/project') ? [] : { data: [], location: { directory } };
  return Response.json(data);
};
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, Node: browser.Node, Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  fetch: fetchResponse,
};
const originals = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

// CodeMirror detects macOS when imported. Install the browser before loading it.
const { ComposerEditor } = await import('@/components/chat/composer/editor/ComposerEditor');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { SyncProvider } = await import('@/sync/sync-context');
const { useUIStore } = await import('@/stores/useUIStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { shownContextModes } = await import('@/lib/workspace/zones');
const { shortcutRegistry } = await import('@/lib/shortcuts');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useKeyboardShortcuts } = await import('./useKeyboardShortcuts');
const { useMiniChatKeyboardShortcuts } = await import('./useMiniChatKeyboardShortcuts');

beforeAll(() => opencodeClient.reconnectToRuntimeBaseUrl());
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  opencodeClient.reconnectToRuntimeBaseUrl();
});

async function withComposer(
  useShortcuts: () => void,
  run: (editor: ComposerEditorHandle, content: HTMLElement) => Promise<void>,
) {
  const previousUI = useUIStore.getState();
  const previousConfig = useConfigStore.getState();
  const previousDirectory = useDirectoryStore.getState();
  useDirectoryStore.setState({ currentDirectory: directory });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const editor = React.createRef<ComposerEditorHandle>();
  const sdk = OpenCode.make({ baseUrl: 'https://model-shortcuts.test', fetch: fetchResponse });
  function Owner() {
    useShortcuts();
    return null;
  }
  try {
    await act(async () => root.render(
      <ThemeSystemProvider>
        <SyncProvider sdk={sdk} directory={directory}>
          <Owner />
          <div data-chat-input="true">
            <ComposerEditor ref={editor} value="ab" onChange={() => {}} languageContext={{
              inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(),
              knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [],
            }} />
          </div>
        </SyncProvider>
      </ThemeSystemProvider>,
    ));
    useUIStore.setState({
      isModelSelectorOpen: false, isCommandPaletteOpen: false, isHelpDialogOpen: false,
      isSessionSwitcherOpen: false, isAboutDialogOpen: false, isSettingsDialogOpen: false,
      shortcutOverrides: { open_model_selector: 'mod+x m', cycle_thinking_variant: 'ctrl+t' },
    });
    useConfigStore.setState({
      providers: [{
        id: 'test', name: 'Test', activation: 'enabled', package: 'test', models: [{
          id: 'test/model', modelID: 'model', providerID: 'test', name: 'Model',
          capabilities: { tools: true, input: ['text'], output: ['text'] },
          variants: [{ id: 'low' }, { id: 'high' }], time: { released: 0 },
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          status: 'active', enabled: true, limit: { context: 0, output: 0 },
        }],
      }],
      currentProviderId: 'test', currentModelId: 'model', currentVariant: 'low',
      currentVariantSelection: { override: 'low', inherited: undefined }, directoryScoped: {},
    });
    const content = host.querySelector<HTMLElement>('.cm-content');
    if (!editor.current || !content) throw new Error('Composer not mounted');
    await act(async () => { editor.current?.focus(); editor.current?.setSelection(1); });
    await run(editor.current, content);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState(previousUI);
    useConfigStore.setState(previousConfig);
    useDirectoryStore.setState(previousDirectory);
    host.remove();
  }
}

async function press(content: HTMLElement, key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  const event = new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ...modifiers, bubbles: true, cancelable: true });
  await act(async () => { content.dispatchEvent(event); });
  return event;
}

for (const [name, useShortcuts] of [['main', useKeyboardShortcuts], ['mini', useMiniChatKeyboardShortcuts]] as const) {
  test(`${name}: Command+X, M opens the model selector without changing composer text`, async () => {
    await withComposer(useShortcuts, async (editor, content) => {
      expect((await press(content, 'x', { metaKey: true })).defaultPrevented).toBe(true);
      expect(useUIStore.getState().isModelSelectorOpen).toBe(false);
      expect((await press(content, 'm')).defaultPrevented).toBe(true);
      expect(useUIStore.getState().isModelSelectorOpen).toBe(true);
      expect(editor.getValue()).toBe('ab');
    });
  });

  test(`${name}: Control+T cycles the variant without transposing composer text`, async () => {
    await withComposer(useShortcuts, async (editor, content) => {
      expect((await press(content, 't', { ctrlKey: true })).defaultPrevented).toBe(true);
      expect(useConfigStore.getState().currentVariant).toBe('high');
      expect(editor.getValue()).toBe('ab');
    });
  });

  test(`${name}: Control+T keeps native editing when the model has no variants`, async () => {
    await withComposer(useShortcuts, async (editor, content) => {
      useConfigStore.setState({ providers: [] });
      await press(content, 't', { ctrlKey: true });
      expect(useConfigStore.getState().currentVariant).toBe('low');
      expect(editor.getValue()).toBe('ba');
    });
  });
}

test('Command+P still opens the command palette', async () => {
  await withComposer(useKeyboardShortcuts, async (editor, content) => {
    expect((await press(content, 'p', { metaKey: true })).defaultPrevented).toBe(true);
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    expect(editor.getValue()).toBe('ab');
  });
});

test('terminal leader opens and closes the terminal without sending shortcut keys to its input', async () => {
  await withComposer(useKeyboardShortcuts, async (_editor, content) => {
    useUIStore.setState({
      isMobile: false, contextPanelByDirectory: {},
      shortcutOverrides: { ...useUIStore.getState().shortcutOverrides, toggle_terminal: 'mod+x t' },
    });
    const isTerminalOpen = () => shownContextModes(
      useUIStore.getState().contextPanelByDirectory[directory],
      useUIStore.getState().contextSurfaceZones,
    ).has('terminal');
    await press(content, 'x', { metaKey: true });
    await press(content, 't');
    expect(isTerminalOpen()).toBe(true);

    const terminal = document.createElement('textarea');
    terminal.dataset.terminalOwner = directory;
    content.parentElement?.append(terminal);
    const input: string[] = [];
    terminal.addEventListener('keydown', (event) => input.push(event.key));
    terminal.focus();
    expect((await press(terminal, 'x', { metaKey: true })).defaultPrevented).toBe(true);
    expect((await press(terminal, 't')).defaultPrevented).toBe(true);
    expect(isTerminalOpen()).toBe(false);
    expect(input).toEqual([]);

    expect((await press(terminal, 'p', { metaKey: true })).defaultPrevented).toBe(false);
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
    expect((await press(terminal, 't', { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(useConfigStore.getState().currentVariant).toBe('low');
    expect(input).toEqual(['p', 't']);

    await press(terminal, 'x', { metaKey: true });
    expect((await press(terminal, 'z')).defaultPrevented).toBe(false);
    expect(isTerminalOpen()).toBe(false);
    expect(input).toEqual(['p', 't', 'z']);

    await press(terminal, 'x', { metaKey: true });
    window.dispatchEvent(new Event('blur'));
    expect((await press(terminal, 't')).defaultPrevented).toBe(false);
    expect(isTerminalOpen()).toBe(false);

    await press(terminal, 'x', { metaKey: true });
    expect((await press(content, 't')).defaultPrevented).toBe(false);
    expect(isTerminalOpen()).toBe(false);
    expect((await press(terminal, 't')).defaultPrevented).toBe(false);

    await press(terminal, 'x', { metaKey: true });
    const resume = shortcutRegistry.suspend();
    try {
      expect((await press(terminal, 't')).defaultPrevented).toBe(false);
      expect(isTerminalOpen()).toBe(false);
    } finally {
      resume();
    }

    // Removing the override restores the existing single-chord terminal key.
    useUIStore.setState({ shortcutOverrides: {} });
    expect((await press(terminal, 'j', { metaKey: true })).defaultPrevented).toBe(true);
    expect(isTerminalOpen()).toBe(true);
    expect((await press(terminal, 'j', { metaKey: true })).defaultPrevented).toBe(true);
    expect(isTerminalOpen()).toBe(false);
  });
});
