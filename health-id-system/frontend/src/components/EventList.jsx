import React from 'react';
import { List, ListItem, ListItemButton, ListItemText, Chip, Typography, Box } from '@mui/material';

const getStatusColor = (status) => {
  switch (status) {
    case 'green': return 'success';
    case 'yellow': return 'warning';
    case 'red': return 'error';
    default: return 'default';
  }
};

const EventList = ({ results, onSelect, selectedId }) => {
  return (
    <Box sx={{ height: '100%', overflowY: 'auto' }}>
      <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
        Журнал событий
      </Typography>
      <List dense>
        {results.map((r) => (
          <ListItem key={r.id} disablePadding>
            <ListItemButton
              selected={selectedId === r.id}
              sx={{
                borderRadius: 2,
                mb: 0.5,
                '&.Mui-selected, &.Mui-selected:hover': {
                  backgroundColor: '#e8f5e9',
                },
              }}
              onClick={() => onSelect(r)}
            >
              <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="body2" fontWeight={600} noWrap>
                    {r.id}
                  </Typography>
                  <Chip
                    label={r.status === 'green' ? 'ЗЕЛЁНАЯ' : r.status === 'yellow' ? 'ЖЁЛТАЯ' : 'КРАСНАЯ'}
                    size="small"
                    color={getStatusColor(r.status)}
                    sx={{ fontSize: 10, px: 1 }}
                  />
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 0.5 }}>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {r.workerId}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {r.timestamp}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    Полнота: {r.completeness}%
                  </Typography>
                  <Box sx={{ width: 8, height: 8, ml: 1, borderRadius: '50%', backgroundColor: getStatusColor(r.status) === 'success' ? '#4caf50' : getStatusColor(r.status) === 'warning' ? '#ff9800' : '#f44336' }} />
                </Box>
              </Box>
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Box>
  );
};

export default EventList;
