import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { C, s } from './theme';

export function IconButton({ name, onPress, label, color = C.text }: { name: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void; label: string; color?: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [s.iconButton, pressed && s.pressed]}><Ionicons accessible={false} importantForAccessibility="no" name={name} size={21} color={color} /></Pressable>;
}

export function Button({ label, onPress, tone = 'light', disabled = false, icon }: { label: string; onPress: () => void; tone?: 'light' | 'quiet' | 'danger'; disabled?: boolean; icon?: React.ComponentProps<typeof Ionicons>['name'] }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.button, tone === 'quiet' && s.quietButton, tone === 'danger' && s.dangerButton, disabled && s.disabled, pressed && !disabled && s.pressed]}>{icon ? <Ionicons accessible={false} importantForAccessibility="no" name={icon} size={16} color={tone === 'light' ? C.bg : tone === 'danger' ? C.red : C.text} /> : null}<Text style={[s.buttonText, tone === 'quiet' && s.quietText, tone === 'danger' && s.dangerText]}>{label}</Text></Pressable>;
}

export function Field({ label, value, onChangeText, placeholder, multiline, keyboardType, secureTextEntry }: { label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; multiline?: boolean; keyboardType?: 'default' | 'email-address' | 'url' | 'numeric'; secureTextEntry?: boolean }) {
  return <View style={s.fieldWrap}><Text style={s.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={C.muted} multiline={multiline} keyboardType={keyboardType} secureTextEntry={secureTextEntry} autoCapitalize={keyboardType === 'email-address' || secureTextEntry ? 'none' : 'sentences'} style={[s.input, multiline && s.multiline]} selectionColor={C.sage} /></View>;
}

