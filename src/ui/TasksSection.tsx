import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { LocalTask } from "../core";
import { C, s } from "./theme";

type Props = {
  tasks: LocalTask[];
  busy: boolean;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
};

export function TasksSection({ tasks, busy, onComplete, onReopen }: Props) {
  const [filter, setFilter] = useState<"open" | "completed">("open");
  const visible = tasks.filter((task) => task.status === filter);

  return (
    <View style={{ gap: 10 }}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>Tasks</Text>
        <View style={s.taskFilters}>
          {(["open", "completed"] as const).map((status) => (
            <Pressable
              key={status}
              accessibilityRole="tab"
              accessibilityLabel={`${status === "open" ? "Open" : "Completed"} tasks`}
              accessibilityState={{ selected: filter === status }}
              onPress={() => setFilter(status)}
              style={[s.taskFilter, filter === status && s.taskFilterActive]}
            >
              <Text
                style={[
                  s.taskFilterText,
                  filter === status && s.taskFilterTextActive,
                ]}
              >
                {status === "open" ? "Open" : "Completed"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {visible.length ? (
        visible.map((task) => (
          <View key={task.id} style={s.taskCard}>
            <View style={s.taskCopy}>
              <Text style={s.taskTitle}>
                {task.importOrigin?.kind === "backup_import" ? `Imported · ${task.title}` : task.title}
              </Text>
              {task.body ? <Text style={s.taskBody}>{task.body}</Text> : null}
              <Text style={s.analysisSource}>
                {task.importOrigin?.kind === "backup_import"
                  ? `Imported task · ${new Date(task.createdAt).toLocaleDateString()}`
                  : `From a saved note · ${new Date(task.createdAt).toLocaleDateString()}`}
              </Text>
              {task.dueAt ? (
                <Text style={s.analysisSource}>
                  Due {new Date(task.dueAt).toLocaleString()}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                filter === "open"
                  ? `Complete ${task.title}`
                  : `Reopen ${task.title}`
              }
              disabled={busy}
              onPress={() =>
                filter === "open" ? onComplete(task.id) : onReopen(task.id)
              }
              style={({ pressed }) => [
                s.iconButton,
                busy && s.disabled,
                pressed && !busy && s.pressed,
              ]}
            >
              <Ionicons
                accessible={false}
                importantForAccessibility="no"
                name={
                  filter === "open"
                    ? "checkmark-circle-outline"
                    : "arrow-undo-outline"
                }
                size={21}
                color={filter === "open" ? C.sage : C.muted}
              />
            </Pressable>
          </View>
        ))
      ) : (
        <Text style={s.emptyText}>
          {filter === "open"
            ? "No open tasks yet. Review a note and save a task when you are ready."
            : "Completed tasks will appear here."}
        </Text>
      )}
    </View>
  );
}
