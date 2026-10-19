import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GeneratedUserAvatar, USER_AVATAR_MARKS, userAvatarIdentity } from '../src/ui/user-avatar';

afterEach(cleanup);

describe('GeneratedUserAvatar', () => {
  it('derives a stable mixed outline and palette from the user id', () => {
    const first = userAvatarIdentity('alice');
    const second = userAvatarIdentity('alice');
    expect(first).toEqual(second);
    expect(first).toEqual({ mark: 'apple', hue: 165 });
    expect(userAvatarIdentity('bob')).not.toEqual(first);
    expect(userAvatarIdentity('bob')).toMatchObject({ mark: 'key' });
    expect(userAvatarIdentity('陈远')).toMatchObject({ mark: 'flower' });
    expect(USER_AVATAR_MARKS).toHaveLength(24);
    expect(new Set(USER_AVATAR_MARKS)).toHaveProperty('size', 24);
  });

  it('renders a local percentage-sized SVG outline without image assets', () => {
    const view = render(<GeneratedUserAvatar id="alice" variant="cell" />);
    const avatar = view.container.querySelector('.user-generated-avatar');
    const outline = avatar?.querySelector('.user-avatar-mark');

    expect(avatar?.getAttribute('data-avatar-mark')).toBe('apple');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(outline?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(outline?.getAttribute('width')).toBe('48%');
    expect(outline?.getAttribute('height')).toBe('48%');
    expect(avatar?.querySelectorAll('svg')).toHaveLength(1);
    expect(avatar?.querySelectorAll('img, image, use, script')).toHaveLength(0);
  });

  it('keeps the status lamp independent from the generated outline', () => {
    const view = render(<GeneratedUserAvatar id="erin" lamp={{ tone: 'bad', title: '已停用' }} />);
    const avatar = view.container.querySelector('.user-generated-avatar');
    const lamp = avatar?.querySelector('.node-lamp');

    expect(avatar?.getAttribute('data-avatar-mark')).toBe('cup');
    expect(lamp?.classList.contains('bad')).toBe(true);
    expect(lamp?.getAttribute('aria-label')).toBe('已停用');
  });
});
