import { describe, expect, test } from 'bun:test'
import { formatRenderEvent, parseRenderEvent, type RenderEvent } from './renderEvents'

describe('parseRenderEvent', () => {
	test('round-trips every event the recorder prints', () => {
		const events: RenderEvent[] = [
			{
				type: 'plan',
				jobs: [
					{
						clipId: 'a1',
						filename: 'Novel.mp3',
						title: 'Novel',
						label: 'hook',
						outputPath: 'recordings/novel-a1-1080x1920.mp4',
						durationSeconds: 58.5,
					},
				],
			},
			{ type: 'start', clipId: 'a1' },
			{ type: 'step', clipId: 'a1', message: 'encoding' },
			{ type: 'done', clipId: 'a1', outputPath: 'recordings/novel-a1-1080x1920.mp4' },
			{ type: 'fail', clipId: 'a1', error: 'boom' },
		]
		for (const event of events) expect(parseRenderEvent(formatRenderEvent(event))).toEqual(event)
	})

	test('ignores ordinary log lines', () => {
		expect(parseRenderEvent('  … capturing 58s')).toBeNull()
		expect(parseRenderEvent('[1/3] Novel.mp3 [a1]')).toBeNull()
	})

	test('rejects malformed events rather than guessing', () => {
		expect(parseRenderEvent('@event {not json')).toBeNull()
		expect(parseRenderEvent('@event {"type":"step","clipId":"a1"}')).toBeNull()
		expect(parseRenderEvent('@event {"type":"plan","jobs":[{"clipId":"a1"}]}')).toBeNull()
		expect(parseRenderEvent('@event {"type":"mystery","clipId":"a1"}')).toBeNull()
	})
})
