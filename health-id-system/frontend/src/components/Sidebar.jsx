import React from 'react';
import { List, ListItem, ListItemText, ListItemButton, Divider, Typography, Box } from '@mui/material';

const Sidebar = ({ open }) => {
  const drawerWidth = 240;

  return (
    <Box
      sx={{
        width: open ? drawerWidth : 0,
        flexShrink: 0,
        transition: (theme) => theme.transitions.create('width', {
          easing: theme.transitions.easing.sharp,
          duration: theme.transitions.duration.enteringScreen,
        }),
        overflowX: 'hidden',
        backgroundColor: '#1a1f29',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="h6" noWrap fontWeight={600}>
          ИССЛЕДОВАТЕЛЬСКАЯ<br/>КОНСОЛЬ<br/>HEALTH_ID
        </Typography>
      </Box>
      <Divider variant="middle" sx={{ color: '#333' }} />
      <Box sx={{ px: 1, pt: 1, color: '#aaa' }}>
        <Typography variant="caption" display="block" sx={{ mb: 0.5 }}>
          ТОЛЬКО ИССЛЕДОВАТЕЛЬСКИЙ РЕЖИМ
        </Typography>
        <Typography variant="caption" display="block" sx={{ fontSize: 11, lineHeight: 1.3 }}>
          Оценка клинических сигналов. Не диагноз и не система юридической идентификации.
        </Typography>
      </Box>
      <Divider variant="middle" sx={{ color: '#333' }} />

      <List sx={{ pt: 1 }}>
        {[
          { label: 'Обзор', icon: '📊' },
          { label: 'Результаты HEALTH_ID', icon: '📋', active: true },
          { label: 'Очередь проверки', icon: '📦' },
          { label: 'Песочница верификации', icon: '🧪' },
          { label: 'Управление и дрейф', icon: '⚙️' },
          { label: 'Исследовательская зона', icon: '🧬' },
        ].map((item, idx) => (
          <ListItem key={idx} disablePadding>
            <ListItemButton sx={{ color: item.active ? '#fff' : '#aaa', borderLeft: item.active ? '3px solid #4caf50' : 'none' }}>
              <Box sx={{ mr: 1 }}>{item.icon}</Box>
              <ListItemText primary={item.label} />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Box>
  );
};

export default Sidebar;
