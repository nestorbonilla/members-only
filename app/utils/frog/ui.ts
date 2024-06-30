import { colors, createSystem } from 'frog/ui';

export const {
  Box,
  Columns,
  Column,
  Divider,
  Heading,
  HStack,
  Rows,
  Row,
  Spacer,
  Text,
  VStack,
  Image,
  vars,
} = createSystem({
  colors: {
    text: '#000000',
    background: '#ffffff',
    black: '#000000',
    yellow: '#FFD400',
    blue: '#0070f3',
    green: '#00ff00',
    red: '#ff0000',
    orange: '#ffaa00',
  },
  fonts: {
    default: [
      {
        name: 'Comfortaa',
        source: 'google',
        weight: 300,
      },
      {
        name: 'Comfortaa',
        source: 'google',
        weight: 400,
      },
      {
        name: 'Comfortaa',
        source: 'google',
        weight: 500,
      },
      {
        name: 'Open Sans',
        source: 'google',
        weight: 400,
      },
      {
        name: 'Open Sans',
        source: 'google',
        weight: 600,
      },
    ],
    madimi: [
      {
        name: 'Madimi One',
        source: 'google',
      },
    ],
  },
});
