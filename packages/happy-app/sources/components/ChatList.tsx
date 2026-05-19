import * as React from 'react';
import { useLocalSetting, useSession, useSessionMessages, useSessionRuntimeProgress, useSetting } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { ActivityIndicator, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, Text, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { ToolGroupView } from './ToolGroupView';
import { DuplicateSheet } from './DuplicateSheet';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { DisplayItem, ToolGroupItem, useGroupedMessages } from '@/hooks/useGroupedMessages';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const SCROLL_THRESHOLD = 300;

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasMoreOlder, isLoadingOlder } = useSessionMessages(props.session.id);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            hasMoreOlder={hasMoreOlder}
            isLoadingOlder={isLoadingOlder}
        />
    )
});

const ListHeader = React.memo((props: { isLoadingOlder: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    // ListFooterComponent on an inverted FlatList renders at the visual top
    // — that is exactly where the spinner for "loading older messages"
    // belongs. The spacer below keeps the header bar from clipping the
    // oldest message.
    return (
        <View>
            {props.isLoadingOlder && (
                <View style={{ paddingVertical: 12, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator size="small" />
                </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasMoreOlder: boolean,
    isLoadingOlder: boolean,
}) => {
    const { theme } = useUnistyles();
    const flatListRef = React.useRef<FlatList>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    // Tracks whether the scroll-button is currently shown, so we only call
    // setShowScrollButton when the threshold is actually crossed instead of
    // on every scroll frame (60Hz). Without this guard, the entire list
    // parent re-renders on every wheel tick.
    const showScrollButtonRef = React.useRef(false);

    // Group consecutive tool calls between text messages into collapsible
    // containers — unless the user disabled it in settings.
    const groupToolCalls = useSetting('groupToolCalls');
    const showThinking = useLocalSetting('showThinking');
    const displayItems = useGroupedMessages(props.messages, groupToolCalls, showThinking);

    // Track which groups the user has manually toggled (flips their default state)
    const [toggledGroups, setToggledGroups] = React.useState<Set<string>>(new Set());

    // Auto-collapse groups when they finish running: clear toggle state so
    // they return to the default (collapsed for completed groups)
    React.useEffect(() => {
        setToggledGroups((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const item of displayItems) {
                if (item.type === 'tool-group' && !item.hasRunning && prev.has(item.id)) {
                    next.delete(item.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [displayItems]);

    const handleToggleGroup = useCallback((groupId: string) => {
        setToggledGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
            }
            return next;
        });
    }, []);

    const keyExtractor = useCallback((item: DisplayItem) => item.id, []);

    // Long-press → fork-from-this-message. Uses the same canFork gate as
    // the rest of the fork affordances: ridden by the expResumeSession
    // experiments toggle, requires a Claude session with claudeSessionId
    // and a machine that's online. Active OR inactive — fork works either
    // way (the on-disk JSONL exists in both cases).
    const session = useSession(props.sessionId);
    const { canFork } = useSessionQuickActions(session!, {});

    const handleForkFromMessage = useCallback((_messageId: string, claudeUuid: string) => {
        Modal.show({
            component: DuplicateSheet,
            props: {
                sessionId: props.sessionId,
                initialClaudeUuid: claudeUuid,
            },
        } as any);
    }, [props.sessionId]);

    const renderItem = useCallback(({ item }: { item: DisplayItem }) => {
        if (item.type === 'tool-group') {
            const defaultExpanded = item.hasRunning;
            const expanded = toggledGroups.has(item.id) ? !defaultExpanded : defaultExpanded;
            return (
                <ToolGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={expanded}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        return (
            <MessageView
                message={item.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
                onForkFromUserMessage={canFork ? handleForkFromMessage : undefined}
            />
        );
    }, [props.metadata, props.sessionId, canFork, handleForkFromMessage, toggledGroups, handleToggleGroup]);

    // In inverted FlatList, offset 0 = latest messages (visual bottom).
    // Offset increases as user scrolls up to see older messages.
    // Auto-stick-to-bottom on new messages is handled natively by FlatList's
    // maintainVisibleContentPosition.autoscrollToBottomThreshold — no JS-side
    // scrollToOffset is needed (and running both produces a fight that drags
    // the user's viewport when reading older messages mid-stream).
    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetY = e.nativeEvent.contentOffset.y;
        const next = offsetY > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
    }, []);

    const scrollToBottom = useCallback(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, []);

    // In an inverted FlatList, `onEndReached` fires when the user scrolls
    // past the visual top — i.e. when they want to see older history.
    // Initial fetch only loads the latest 100 messages (see
    // sync.fetchInitialLatestPage), so we lazy-load earlier pages here.
    const sessionId = props.sessionId;
    const hasMoreOlder = props.hasMoreOlder;
    const isLoadingOlder = props.isLoadingOlder;
    const handleLoadOlder = useCallback(() => {
        if (!hasMoreOlder || isLoadingOlder) return;
        void sync.loadOlderMessages(sessionId);
    }, [sessionId, hasMoreOlder, isLoadingOlder]);

    // On macOS/web, Shift+wheel swaps deltaX/deltaY — restore vertical scrolling
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const node = (flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
        if (!node) return;
        const handler = (e: WheelEvent) => {
            if (e.shiftKey && Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) < 1) {
                node.scrollTop += e.deltaX;
                e.preventDefault();
            }
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
    }, []);

    return (
        <View style={{ flex: 1 }}>
            <SessionProgressBar sessionId={props.sessionId} />
            <FlatList
                ref={flatListRef}
                data={displayItems}
                inverted={true}
                keyExtractor={keyExtractor}
                maintainVisibleContentPosition={{
                    // Anchor on the second-newest message (index 1), not the
                    // newest. The newest slot (index 0) gets a brand-new item
                    // each agent token, which would otherwise destabilise the
                    // anchor and drag the viewport up.
                    //
                    // autoscrollToTopThreshold: for INVERTED lists this is
                    // actually the auto-stick-to-visual-bottom threshold —
                    // contentOffset 0 is at the visual bottom in an inverted
                    // list, and this prop sticks the viewport to offset 0
                    // when the user is within N units of it.
                    minIndexForVisible: 1,
                    autoscrollToTopThreshold: 50,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
                ListFooterComponent={<ListHeader isLoadingOlder={props.isLoadingOlder} />}
                onEndReached={handleLoadOlder}
                onEndReachedThreshold={0.5}
            />
            {showScrollButton && (
                <View style={styles.scrollButtonContainer}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.scrollButton,
                            pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                        ]}
                        onPress={scrollToBottom}
                    >
                        <Octicons name="arrow-down" size={14} color={theme.colors.text} />
                    </Pressable>
                </View>
            )}
        </View>
    )
});

/**
 * Sticky status bar that mirrors Claude TUI's bottom-line state while a
 * turn is thinking. Pinned to the visual top of the message stream, just
 * under the navigation header. Renders nothing when the session isn't
 * thinking or no runtime progress has been received yet — so PTY sessions
 * with the bar enabled cost zero pixels at rest, and SDK sessions never
 * see it.
 */
const SessionProgressBar = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId);
    const progress = useSessionRuntimeProgress(props.sessionId);
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();

    if (!session?.thinking || !progress) return null;

    const elapsedLabel = formatElapsed(progress.elapsedMs);
    const tokensLabel = formatTokens(progress.tokens);

    return (
        <View
            pointerEvents="none"
            style={[styles.progressBarContainer, { top: headerHeight + safeArea.top + 4 }]}
        >
            <View style={styles.progressBar}>
                {progress.title ? (
                    <Text numberOfLines={1} style={styles.progressTitle}>
                        {progress.title}
                    </Text>
                ) : null}
                <Text numberOfLines={1} style={styles.progressMeta}>
                    {elapsedLabel}
                    {'  ·  ↓ '}
                    {tokensLabel}
                    {progress.effort ? `  ·  ${t('sessionProgress.effortSuffix', { effort: progress.effort })}` : ''}
                </Text>
            </View>
        </View>
    );
});

function formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

const styles = StyleSheet.create((theme) => ({
    progressBarContainer: {
        position: 'absolute',
        left: 12,
        right: 12,
        zIndex: 5,
        alignItems: 'center',
    },
    progressBar: {
        maxWidth: 480,
        width: '100%',
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 4,
        shadowOpacity: theme.colors.shadow.opacity * 0.6,
        elevation: 3,
    },
    progressTitle: {
        color: theme.colors.text,
        fontSize: 13,
        marginBottom: 2,
        ...Typography.default('semiBold'),
    },
    progressMeta: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.mono(),
    },
    scrollButtonContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 12,
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'box-none',
    },
    scrollButton: {
        borderRadius: 16,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2,
        shadowOpacity: theme.colors.shadow.opacity * 0.5,
        elevation: 2,
    },
    scrollButtonDefault: {
        backgroundColor: theme.colors.surface,
        opacity: 0.9,
    },
    scrollButtonPressed: {
        backgroundColor: theme.colors.surface,
        opacity: 0.7,
    },
}));
