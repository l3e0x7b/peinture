import React, { ReactNode } from 'react';

interface TooltipProps {
  content: string | ReactNode;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  delay?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({ 
  content, 
  children, 
  position = 'top',
  className = '',
  delay = 200
}) => {
  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  return (
    <div className={`relative flex items-center group/tooltip ${className}`}>
      {children}
      <div 
        className={`
          absolute z-50 px-3 py-1.5 
          text-xs font-medium text-white bg-[#1A1625] 
          border border-white/10 rounded-lg shadow-xl shadow-black/50
          whitespace-nowrap pointer-events-none 
          opacity-0 group-hover/tooltip:opacity-100
          transition-all duration-200 ease-out origin-center
          ${positionClasses[position]}
        `}
        style={{ transitionDelay: `${delay}ms` }}
      >
        {content}
      </div>
    </div>
  );
};