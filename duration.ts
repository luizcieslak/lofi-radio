import ffmpeg from 'fluent-ffmpeg'

const ffprobePromise = async (file: string) => {
	const { promise, reject, resolve } = Promise.withResolvers<ffmpeg.FfprobeData>()
	ffmpeg.ffprobe(file, (err, data) => {
		if (err) {
			console.error(err)
			reject(err)
			return
		}
		resolve(data)
	})

	return promise
}

const getSongDuration = async (file: string): Promise<number> => {
	const probeData = await ffprobePromise(file)
	if (!probeData.format?.duration) {
		throw new Error('No duration found in probe data')
	}
	return probeData.format.duration
}

export default getSongDuration
