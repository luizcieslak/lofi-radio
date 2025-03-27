export interface SongListItem {
	title: string
	artist: string
	album: string
	albumCover: string
	filename: string
}

const songList = [
	{
		title: 'Cara',
		artist: 'Google Traslator',
		album: 'Yes',
		albumCover: 'https://placecats.com/300/200',
		filename: 'cara.mp3',
	},
	{
		title: 'Guy',
		artist: 'Google Traslator',
		album: 'Yes',
		albumCover: 'https://placecats.com/300/201',
		filename: 'guy.mp3',
	},
	{
		title: 'Sao Paulo',
		artist: 'Racionais MCs',
		album: 'Sim',
		albumCover: 'https://placecats.com/300/202',
		filename: 'saopaulo.mp3',
	},
] satisfies SongListItem[]

export default songList
