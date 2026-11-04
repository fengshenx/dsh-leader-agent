/**
 * 确认弹窗。
 *
 * 外壳（遮罩、Escape、焦点循环、初始焦点、关闭回焦）由 `modal-shell.js` 提供，
 * 与宿主 `packages/client/ui-primitives/src/Modal.tsx` 的分工一致；本模块只留
 * 确认框自己的内容与按钮。
 *
 * @module dsh-leader-agent/client/confirm-dialog
 */

import { createElement } from 'react'
import { ModalShell } from './modal-shell.js'

/**
 * 确认弹窗。
 *
 * @param {object} props - 组件属性
 * @param {boolean} props.open - 是否显示
 * @param {string} props.title - 标题
 * @param {string} props.description - 说明文字
 * @param {string} props.confirmLabel - 确认按钮文案
 * @param {string} props.cancelLabel - 取消按钮文案
 * @param {boolean} props.danger - 确认按钮是否用危险色
 * @param {boolean} props.busy - 正在执行，禁用按钮
 * @param {string} props.error - 错误文案
 * @param {() => void} props.onConfirm - 确认
 * @param {() => void} props.onCancel - 取消
 * @returns {object | null} React 元素；未打开时 null
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  error = '',
  onConfirm,
  onCancel,
}) {
  return createElement(ModalShell, {
    open,
    onClose: onCancel,
    title,
    closeLabel: cancelLabel,
    description,
    children: error === ''
      ? null
      : createElement('div', { className: 'dsh-leader-agent-modal-error', role: 'alert' }, error),
    footer: [
      createElement('button', {
        key: 'cancel',
        type: 'button',
        className: 'dsh-leader-agent-modal-button dsh-leader-agent-modal-button-outline',
        disabled: busy,
        onClick: onCancel,
      }, cancelLabel),
      createElement('button', {
        key: 'confirm',
        type: 'button',
        'data-modal-autofocus': '',
        className: `dsh-leader-agent-modal-button dsh-leader-agent-modal-button-outline${danger ? ' dsh-leader-agent-modal-button-danger' : ''}`,
        disabled: busy,
        onClick: onConfirm,
      }, confirmLabel),
    ],
  })
}
